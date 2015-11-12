var crypto = require('crypto')
  , util = require('util')
  , when = require('when')
  , EventEmitter = require('events').EventEmitter
  , alpha = 'abcdefghijklmnopqrstuvwxyz'.split('')
  , letters = /([a-z])/g

function defaultCondition() {
  return true
}

module.exports = function (client) {
  return new Rollout(client)
}

function Rollout(client) {
  EventEmitter.call(this)
  this.client = client
  this._handlers = {}
}

util.inherits(Rollout, EventEmitter)

Rollout.prototype.handler = function (key, flags) {
  var self = this
  self._handlers[key] = flags
  var orig_percentages = []
  var keys = Object.keys(flags).map(function (k) {
    orig_percentages.push(flags[k].percentage)
    return key + ':' + k
  })
  self.client.mget(keys, function (err, percentages) {
    var _keys = []
    var nullKey = false
    percentages.forEach(function (p, i) {
      if (p === null) {
        var val = Math.max(0, Math.min(100, orig_percentages[i] || 0))
        nullKey = true
        _keys.push(keys[i], val)
      }
    })
    if (nullKey) {
      self.client.mset(_keys, function () {
        self.emit('ready')
      })
    } else {
      self.emit('ready')
    }
  })
}

Rollout.prototype.multi = function (keys) {
  var multi = this.client.multi()
  var self = this
  var settler = when.settle(keys.map(function (k) {
    return self.get(k[0], k[1], k[2], multi)
  }))
  multi.exec(function () {})
  return settler
}

Rollout.prototype.get = function (key, id, opt_values, multi) {
  var flags = this._handlers[key]
  var likely = this.val_to_percent(key + id)
  var _id = {
    id: id
  }
  if (!opt_values) opt_values = _id
  if (!opt_values.id) opt_values.id = id
  return when.promise(function (resolve, reject) {
    var keys = Object.keys(flags).map(function (k) {
      return key + ':' + k
    })
    var client = multi || this.client
    client.mget(keys, function (err, percentages) {
      var i = 0
      var deferreds = []
      for (var modifier in flags) {
        // in the circumstance that the key is not found, default to original value
        if (percentages[i] === null) {
          percentages[i] = flags[modifier].percentage
        }
        if (likely < percentages[i]) {
          if (!flags[modifier].condition) flags[modifier].condition = defaultCondition
          var output = flags[modifier].condition(opt_values[modifier])
          if (when.isPromiseLike(output)) deferreds.push(output)
          else if (output) return resolve(true)
        }
        i++
      }
      if (deferreds.length) {
        when.any(deferreds).then(resolve, reject)
      } else {
        reject()
      }
    })
  }.bind(this))
}

Rollout.prototype.update = function (key, percentage_map) {
  var self = this
  return when.promise(function (resolve) {
    var keys = []
    for (var k in percentage_map) {
      keys.push(key + ':' + k, percentage_map[k])
    }
    self.client.mset(keys, resolve)
  })
}

Rollout.prototype.mods = function (name) {
  var client = this.client
  var keys = []
  var names = []
  for (var flag in this._handlers[name]) {
    keys.push(name + ':' + flag)
    names.push(flag)
  }
  return when.promise(function (resolve) {
    client.mget(keys, function (err, values) {
      var flags = {}
      values.forEach(function (val, i) {
        flags[names[i]] = val
      })
      resolve(flags)
    })
  })
}

Rollout.prototype.flags = function () {
  return Object.keys(this._handlers)
}

Rollout.prototype.val_to_percent = function (text) {
  return parseInt(crypto.createHash('md5').update(text).digest('hex').substr(0, 5), 16) % 100;
}
