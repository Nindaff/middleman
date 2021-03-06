var EventEmitter = require('events').EventEmitter
var http = require('http')
var Url = require('url')
var inherits = require('util').inherits
var Buffer = require('buffer').Buffer
var request = require('request')
var urlJoin = require('url-join')
var assign = require('object-assign')
var sizeof = require('object-sizeof')
var omit = require('lodash.omit')
var Cache = require('./cache')
var WriteBuffer = require('./writeBuffer')

/**
 * Middle man
 * @param {Object} options
 * @param {String} options.target URI to proxy for.
 * @param {Object} [options.setHeaders = {}] Headers to sent with the request,
 *                                     when being proxied.
 * @param {String|Array<String>} [options.cacheMethods = 'any']
 *                               Http methods that should be cached, blocks all
 *                               other HTTP methods from the cache. By Default
 *                               caches for all HTTP methods.
 * @param {Number} [options.maxAge = Infinity] Max cache age (milliseconds).
 * @param {Number|String} [options.maxSize = Infinity] Max size in bytes for the
 *                                         Cache. If a string is passed, it will
 *                                         be parsed by the `bytes` library.
 * @param {Boolean} [options.lru = true] Implement LRU caching.
 * @param {Store|Object} [options.store = MemoryStore] Store interface for cache
 * @param {Boolean} [options.followRedirect = true] Follow redirects, passed
 *                                          to `request` library.
 * @param {Function} [options.bypass = (res) => false]  A function that takes
 *                                   http.IncomingMessage instance from the
 *                                   `request` library and returns a boolean
 *                                   `true` will bypass the cache, `false` will
 *                                   tell middleman to cache the response. The
 *                                   `res` is an http response from the `target`
 * @param {Function} [optoins.createKey = (req, url) => "${req.method}:${url.path}"]
 *                                      A function that takes two arguments:
 *                                      `req` (http.IncomingMessage) and `url`
 *                                      (Url) and returns a string.
 * @param {Function} [options.httpError (req,res)] A function that takes two
 *                                      arguments: req (http.IncomingMessage)
 *                                      and res (http.ServerResponse), and sends
 *                                      an appropriate response when an error
 *                                      occured. By default this is a 500 error
 *                                      message.
 * @public
 * @constructor
 */
function Middleman (options) {
  if (!(this instanceof Middleman)) return new Middleman(options)
  options = options || {}
  EventEmitter.call(this)
  this.settings = assign({
    setHeaders: {},
    ignoreHeaders: [],
    cacheMethods: 'any',
    followRedirect: true,
    maxAge: Infinity,
    maxSize: Infinity,
    lru: true,
    store: undefined,
    target: undefined
  }, options)

  if (options.bypass) {
    this._bypass = options.bypass
  }
  if (options.createKey) {
    this._createKey = options.createKey
  }
  if (options.httpError) {
    this._httpError = options.httpError
  } else {
    this._httpError = null
  }

  if (typeof this._createKey !== 'function') {
    throw new TypeError('options.createKey must be a function')
  }
  if (typeof this._bypass !== 'function') {
    throw new TypeError('options.bypass must be a function')
  }
  if (this._httpError && typeof this._httpError !== 'function') {
    throw new TypeError('options.httpError must be a function')
  }
  if (typeof this.settings.target === 'undefined') {
    throw new Error('Middleman requires options.target')
  }

  this.server = null
  this.cache = new Cache({
    maxAge: this.settings.maxAge,
    maxSize: this.settings.maxSize,
    lru: this.settings.lru,
    store: this.settings.store
  })
  this.init()
}
inherits(Middleman, EventEmitter)

Middleman.prototype.init = function () {
  // compile methods
  var _cacheMethods = this.settings.cacheMethods
  if (typeof _cacheMethods === 'string') {
    if (_cacheMethods === 'any') {
      this.settings.cacheMethods = [/\w+/]
    } else {
      this.settings.cacheMethods = [createRegExp(_cacheMethods)]
    }
  } else if (Array.isArray(_cacheMethods)) {
    this.settings.cacheMethods = _cacheMethods.map(createRegExp)
  } else {
    throw new TypeError('options.cacheMethods must be of String or Array type')
  }

  // convert ignoreHeaders to lower case
  this.settings.ignoreHeaders = this.settings.ignoreHeaders.map(function (hdr) {
    return hdr.toLowerCase()
  })
}

/**
 * Handle a `Request` event
 * @param  {http.IncomingMessage} req
 * @param  {http.ServerResponse} res
 * @param {Object} options
 * @param {String} [options.stripPrefix = ''] Strip the given string from
 *                                      begining of url.
 * @param {String} [options.basePath = ''] Append the incoming url to this
 *                                     path, AFTER striping the given prefix.
 * @example
 * 	var proxy = new Middleman({
 * 		target: 'http://test.io'
 * 	})
 * 	...
 * 	proxy.http(req, res, {
 * 		stripPrefix: '/ignore',
 * 		basePath: '/someBasePath'
 * 	})
 *
 * GET /ignore/somePath?foo=bar#baz
 * 	=> http://test.io/someBasePath/somePath?foo=bar#baz
 * @public
 */
Middleman.prototype.http = function (req, res, options) {
  options = assign({
    basePath: '',
    stripPrefix: ''
  }, options || {})

  var url = Url.parse(req.url)
  var key = this._createKey(req, url)
  var uri = this._createUri(url, options.stripPrefix, options.basePath)

  this.emit('request', req, res)
  this.cache.get(key).bind(this)
    .then(function (data) {
      if (!data) {
        this.emit('proxy request', req, res)

        // The request module checks for `setHeader` method on pipes, and
        // populates the response headers automatically. This is probably
        // the most effecient way to control which headers get populated
        // without another pipe or not pipeing alltogether.
        var ignoreHeaders = this.settings.ignoreHeaders
        if (ignoreHeaders.length) {
          var resSetHeader = res.setHeader
          res.setHeader = function (hdr) {
            if (!~ignoreHeaders.indexOf(hdr.toLowerCase())) {
              return resSetHeader.apply(res, arguments)
            }
          }
        }

        var proxy = this._proxy(req, uri, key)
        proxy.on('error', function (err) {
          this.emit('error', err)
          this._errorResponse(req, res)
        }.bind(this))
        proxy.pipe(res)
      } else {
        this.emit('cache request', req, res)
        this._send(data.value, req, res)
      }
    })
    .catch(function (err) {
      this.emit('error', err)
      this._errorResponse(req, res)
    })
}

/**
 * Convenience method, returns `http` bound with instance context
 * @return {Function}
 * @public
 */
Middleman.prototype.handler = function (options) {
  return function (req, res) {
    return this.http(req, res, options)
  }.bind(this)
}

/**
 * Convenience method, creates an instance of http.Server. Populates `server`
 * property with http.Server instance.
 * @return {Middleman}
 * @public
 */
Middleman.prototype.listen = function () {
  var server = http.createServer(this.handler())
  server.listen.apply(server, arguments)
  this.server = server
  return this
}

/**
 * Set `createKey`, chainable
 * @param  {Function} fn
 * @return {Middleman} this
 * @public
 */
Middleman.prototype.createKey = function (fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('createKey requires a function')
  }
  this._createKey = fn
  return this
}

/**
 * Set `bypass`, chainable.
 * @param  {Function} fn
 * @return {Middleman} this
 * @public
 */
Middleman.prototype.bypass = function (fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('bypass requires a function')
  }
  this._bypass = fn
  return this
}

Middleman.prototype.httpError = function (fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('httpError requires a function')
  }
  this._httpError = fn
  return this
}

/**
 * Parses the cachedResponse if needed, sends the cached response to `res`.
 * @param  {CacedResponse|Object} cachedResponse Cache value
 * @param  {http.IncomingMessage} req            Curret Request
 * @param  {http.ServerResponse} res             Current response
 * @private
 */
Middleman.prototype._send = function (cachedResponse, req, res) {
  if (!(cachedResponse instanceof CachedResponse)) {
    try {
      if (typeof cachedResponse === 'string') {
        cachedResponse = CachedResponse.parseJSON(cachedResponse)
      } else {
        cachedResponse = CachedResponse.parse(cachedResponse)
      }
    } catch (e) {
      this.emit('error', new Error('Invalid cache value'))
      return this._errorResponse(req, res)
    }
  }
  res.writeHead(cachedResponse.status, cachedResponse.headers)
  res.end(cachedResponse.body)
}

/**
 * Server a default error message
 * @private
 */
Middleman.prototype._errorResponse = function (req, res) {
  if (this._httpError) {
    return this._httpError(req, res)
  }
  res.writeHead(500, {'Content-Type': 'text/plain'})
  res.end('Internal Server Error')
}

/**
 * Proxy the request, if the request and the proxied response, the body, status
 * and header of the proxied response will be cached.
 * @param  {http.IncomingMessage} req
 * @param {String} uri Uri that has been processed by `_createUri`
 * @param {String} key Cache key that has been processed by `_createKey`
 * @return {http.IncomingMessage}     http.IncomingMessage instance created with
 *                                    the `request` library.
 * @private
 */
Middleman.prototype._proxy = function (req, uri, key) {
  var proxy = req.pipe(request({
    uri: uri,
    followRedirect: this.settings.followRedirect,
    headers: this.settings.setHeaders
  }))
  if (!this._isCacheable(req)) {
    return proxy
  }

  var body = new WriteBuffer()
  var postShouldCache = true
  var response

  proxy
    .on('data', onData.bind(this))
    .on('response', onResponse.bind(this))
    .on('end', onEnd.bind(this))
  return proxy

  function onData (chunk) {
    body.write(chunk)
  }

  function onResponse (_response) {
    response = _response
    postShouldCache = !this._bypass(response)
  }

  function onEnd () {
    if (!postShouldCache) {
      return body.close()
    }
    var cached = new CachedResponse(
      response.statusCode,
      this._omitHeaders(response.headers),
      body.toBuffer()
    )
    body.close()
    this.cache.set(key, cached).bind(this)
      .catch(function (err) {
        this.emit('error', err)
      })
  }
}

/**
 * Returns an object ignoring the headers declared in `options.ignoreHeaders`
 * @param  {Object} headers Incoming headers from proxy
 * @return {Object}
 */
Middleman.prototype._omitHeaders = function (headers) {
  return omit(headers, this.settings.ignoreHeaders)
}

/**
 * Determine whether a request should be cached.
 * @param  {http.IncomingMessage} req Request
 * @return {Boolean}
 * @private
 */
Middleman.prototype._isCacheable = function (req) {
  var cacheMethods = this.settings.cacheMethods
  var method = req.method
  var i = cacheMethods.length
  while (i--) {
    if (cacheMethods[i].test(method)) {
      return true
    }
  }
  return false
}

/**
 * Joins the request url with the `target`.
 * @param  {Object} url The parsed result of the incoming url
 * @param {String} stripPrefix Strip begging of `pathname`
 * @param {String} targetPath Append the entire result to this path.
 * @return {String}
 * @private
 */
Middleman.prototype._createUri = function (url, stripPrefix, basePath) {
  url.pathname = urlJoin(
    basePath,
    url.pathname.replace(new RegExp('^' + stripPrefix), '')
  )
  return urlJoin(this.settings.target, url.format())
}

/**
 * Default `createKey`, "{method}:{path}"
 * @param  {http.IncomingMessage} req Request
 * @param  {Object} url Result of `Url.parse(request.url)`
 * @return {String}     Cache key
 * @private
 */
Middleman.prototype._createKey = function (req, url) {
  return req.method + ':' + url.path
}

/**
 * Default `bypass` method never bypasses the cache.
 * @return {Boolean}
 * @private
 */
Middleman.prototype._bypass = function () {
  return false
}

/**
 * Helper function, returns a RegExp that matches the exact string given, ignore
 * case
 * @param  {String} str String to matche
 * @return {RegExp}
 */
function createRegExp (str) {
  return new RegExp('^' + str + '$', 'i')
}

module.exports = Middleman

/**
 * Cache a responses status, headers and body.
 * @param {number} status  Status code
 * @param {Object} headers Headers
 * @param {buffer} body    Response body
 */
function CachedResponse (status, headers, body) {
  if (!(this instanceof CachedResponse)) {
    return new CachedResponse(status, headers, body)
  }
  this.status = status
  this.headers = headers
  this.body = body
}

/**
 * Create a new CachedResponse from a CachedResponse-like object. The object must
 * have the following properties: `status`, `headers`, and `body`, to meet the
 * "CachedResponse-like" standards. Also the `body` property can be the result
 * of parsing a JSON-serialized buffer, meaning it be an object with two
 * properties
 * `type`, and `data`.
 *
 * @param  {Object} obj CachedResponse-like object
 * @param {Number} obj.status  The status code
 * @param {Object} obj.headers Headers object
 * @param {Object|Buffer} obj.body Response body, see above for explaination
 * @return {CachedResponse}     CachedResponse instance
 */
CachedResponse.parse = function (obj) {
  if (typeof obj !== 'object' ||
    typeof obj.status !== 'number' ||
    typeof obj.headers !== 'object' ||
    (typeof obj.body !== 'object' && !(obj.body instanceof Buffer))) {
    throw new Error('Invalid CachedResponse')
  }
  var body
  if (obj.body instanceof Buffer) {
    body = obj.body
  } else if (Array.isArray(obj.body)) {
    body = new Buffer(obj.body)
  } else {
    if (obj.body.type !== 'Buffer' || !Array.isArray(obj.body.data)) {
      throw new Error('Invalid CachedResponse Buffer')
    }
    body = new Buffer(obj.body.data)
  }
  return new CachedResponse(obj.status, obj.headers, body)
}

/**
 * Convenience method for, `CachedResponse.parse(JSON.parse(data))`
 * @param  {string} json
 * @return {cachedResponse}
 */
CachedResponse.parseJSON = function (json) {
  var obj = JSON.parse(json)
  return CachedResponse.parse(obj)
}

/**
 * Size in bytes of instance.
 * @return {Number}
 */
CachedResponse.prototype.size = function () {
  return sizeof(this.status) + sizeof(this.headers) + this.body.length
}

module.exports.CachedResponse = CachedResponse
