
var util = require('util'),
    stream = require('stream'),
    IndexError = require('./IndexError');

// @todo: change flood control to work off (503 error rate/interval) rather
// than total active requests. (this will auto-balance depending on the cluster)
// @rationale: the cluster can become more or less responsive at different times
// such as garbage collection and index merging.
// The backoff value should be variable across the run and repend on responses
// from the ES cluster and not on a hard limit imposed by the client.
// This will also give better flood control if multiple esclient processes are
// running at the same time.

var BufferedBulkStream = function( client, options )
{
  this.client = client;
  this.buffer = [];
  this.flooding = false;
  this.options = options || { buffer: 1000, timeout: 1000, throttle: 20 }
  this.stats = { written: 0, inserted: 0, ok: 0, error: 0, active_requests: 0, retries: 0 }
  this.timeout = null;

  // Call constructor from stream.Writable
  stream.Writable.call( this, { objectMode: true } );

  // Log errors to stderr
  this.on( 'error', console.error.bind( console ) );

  // Try to flush when the stream ends
  this.on( 'end', this.flush.bind( this, true ) );
}

// Inherit prototype from stream.Writable
util.inherits( BufferedBulkStream, stream.Writable )

var resumeFunction = function(){}

BufferedBulkStream.prototype.batch = function( hasFailures ){
  // console.log( 'batch', hasFailures );
  if( hasFailures ){
    this.options.throttle -= 2;
    if( this.options.throttle < 20 ) this.options.throttle = 20;
  }
  else if( Math.random() > 0.9 ){
    this.options.throttle++;
  }
}

// Handle new messages on the stream
BufferedBulkStream.prototype._write = function( chunk, enc, next )
{
  // BufferedBulkStream accepts Objects or JSON encoded strings
  var record = this.parseChunk( chunk );

  // Record message error stats
  this.stats[ record? 'ok':'error' ]++;

  if( record )
  {
    // Push command to buffer
    this.buffer.push({ index: {
      _index: record._index,
      _type: record._type,
      _id: record._id
    }}, record.data );
    
    this.flush();
  }

  // Handle partial flushes due to inactivity
  clearTimeout( this.timeout );
  this.timeout = setTimeout( function(){
    this.flush( true );
  }.bind(this), this.options.timeout );

  resumeFunction = next;
  if( !this.flooding ) next();
};

// Flush buffer to client
BufferedBulkStream.prototype.flush = function( force )
{
  // Buffer not full
  if( this.buffer.length < 2 ){ return; } // Prevent 'Failed to derive xcontent from org.elasticsearch.common.bytes.BytesArray@0'
  if( !force && ( this.buffer.length / 2 ) < this.options.buffer ){ return; }

  // Move commands out of main buffer
  var writeBuffer = this.buffer.splice( 0, this.options.buffer * 2 );
  writeBufferTotal = ( writeBuffer.length / 2 );
  
  // Write buffer to client
  this.stats.written += writeBufferTotal;
  this.stats.active_requests++;

  // flood control backoff
  if( this.stats.active_requests >= this.options.throttle ){
    this.flooding = true;
    // this.emit( 'backoff' );
  }

  this.client.bulk( { body: writeBuffer }, function( err, resp ){

    this.stats.active_requests--;

    // major error
    // @todo: retry whole batch?
    if( err ){
      this.stats.error += writeBufferTotal;
       return this.emit( 'error', new IndexError( err || 'bulk index error', null, resp ));
    }

    // response does not contain items
    // @todo: retry whole batch?
    if( !resp || !resp.items ){
      this.stats.error += writeBufferTotal; // consider them as failed
      return this.emit( 'error', new IndexError( 'invalid resp from es bulk index operation', null, resp ));
    }

    // process response
    this.validateBulkResponse( writeBuffer, resp );

    // flood control resume
    if( this.stats.active_requests < this.options.throttle && this.flooding ){
      this.flooding = false;
      // this.emit( 'resume' );
      if( 'function' == typeof resumeFunction ) resumeFunction();
    }

    // Stats
    this.emitStats();

  }.bind(this));

  // Stats
  this.emitStats();
}

BufferedBulkStream.prototype.validateBulkResponse = function( writeBuffer, resp ){

  var hasFailures = false;

  // create a map of response codes -> query positions
  var responseCodes = resp.items.reduce( function( codes, item, i ){
    if( !codes[ item.index.status ] ){ codes[ item.index.status ] = []; }
    codes[ item.index.status ].push( i );
    
    if( item.index.status == '503' ){
      hasFailures = true;
    }
    
    return codes;
  }, {});

  this.batch( hasFailures );

  // iterate over ES responses for each item in bulk request
  for( var code in responseCodes ){

    // Successfully updated index
    if( code == '200' ){
      this.stats.inserted += responseCodes['200'].length;
    }

    // Successfully created index
    else if( code == '201' ){
      this.stats.inserted += responseCodes['201'].length;
    }

    // Retry-able failure
    else if( code == '503' ){
      responseCodes['503'].forEach( function( i ){
        var startIndex = i * 2;
        // Push back in to buffer to try again
        this.buffer.push(
          writeBuffer.slice( startIndex +0, startIndex +1 )[0],
          writeBuffer.slice( startIndex +1, startIndex +2 )[0]
        );
        this.stats.retries++;
      }, this);
    }

    // Elasticsearch returned an error
    else if( code == '400' ){
      this.stats.error += responseCodes['400'].length;

      // Format error info and emit
      responseCodes['400'].forEach( function( i ){
        this.emit( 'error', new IndexError(
          resp.items[ i ].index.error,
          writeBuffer.slice( (i*2)+1, (i*2)+2 )[0],
          resp.items[ i ]
        ));
      }, this);
    }

    // Unknown response code
    else {
      this.stats.error += responseCodes[code].length;

      // Format error info and emit
      responseCodes[code].forEach( function( i ){
        this.emit( 'error', new IndexError(
          'unknown response code',
          writeBuffer.slice( (i*2)+1, (i*2)+2 )[0],
          resp.items[ i ]
        ));
      }, this);
    }

  }
}

// Stats
BufferedBulkStream.prototype.emitStats = function()
{
  this.emit( 'stats', {
    written: this.stats.written - this.stats.retries,
    indexed: this.stats.inserted,
    errored: this.stats.error,
    retries: this.stats.retries,
    active_requests: this.stats.active_requests,
    queued: this.stats.written - this.stats.inserted - this.stats.error - this.stats.retries
  });
}

// BufferedBulkStream accepts Objects or JSON encoded strings
BufferedBulkStream.prototype.parseChunk = function( chunk )
{
  if( 'string' === typeof chunk ){
    try {
      chunk = JSON.parse( chunk.toString() );
    } catch( e ){
      this.emit( 'error', 'failed to parse JSON chunk' );
      return;
    }
  }
  
  if( 'object' === typeof chunk ){
    if( !chunk._index ){
      this.emit( 'error', 'invalid index specified' );
      return;
    } else if( !chunk._type ){
      this.emit( 'error', 'invalid type specified' );
      return;
    } else if( !chunk._id ){
      this.emit( 'error', 'invalid id specified' );
      return;
    }
    
    // Chunk is valid
    return chunk;
  }

  this.emit( 'error', 'invalid bulk API message' );
  return;
}

module.exports = BufferedBulkStream;