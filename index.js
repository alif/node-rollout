var crypto = require('crypto')
var Promise = require('bluebird')

module.exports = function (client, options) {
  return new Rollout(client, options)
}

function Rollout(client, options) {
  if (client && client.clientFactory) {
    this.clientFactory = client.clientFactory
  } else {
    this.clientFactory = function () {
      return client
    }
  }
  if (options && options.prefix) {
    this.prefix = options.prefix
  }
  this._handlers = {}
}

Rollout.prototype.handler = function (key, modifiers) {
  this._handlers[key] = modifiers
  var configPercentages = []
  var configKeys = Object.keys(modifiers).map(function (modName) {
    configPercentages.push(modifiers[modName].percentage)
    return this.generate_key(key, modName)
  }.bind(this))
  return getRedisKeys(this.clientFactory(), configKeys)
  .then(function(persistentPercentages) {
    var persistKeys = []
    persistentPercentages.forEach(function (p, i) {
      if (p === null) {
        p = normalizePercentageRange(configPercentages[i])
        persistKeys.push(configKeys[i], JSON.stringify(p))
        persistentPercentages[i] = p
      }
    })
    if (persistKeys.length) {
      return setRedisKeys(this.clientFactory(), persistKeys)
      .then(function() {
        return persistentPercentages
      })
    }
    return persistentPercentages
  }.bind(this))
}

Rollout.prototype.multi = function (keys) {
  var multi = this.clientFactory().multi()
  // Accumulate get calls into a single "multi" query
  var promises = keys.map(function (k) {
    return this.get(k[0], k[1], k[2], multi).reflect()
  }.bind(this))
  // Perform the batch query
  return new Promise(function (resolve, reject) {
    multi.exec(promiseCallback(resolve, reject))
  })
  .then(function () {
    return Promise.all(promises)
  })
}

Rollout.prototype.get = function (key, id, opt_values, multi) {
  opt_values = opt_values || { id: id }
  opt_values.id = opt_values.id || id
  var modifiers = this._handlers[key]
  var keys = Object.keys(modifiers).map(this.generate_key.bind(this, key))
  var likely = this.val_to_percent(key + id)
  return getRedisKeys(multi || this.clientFactory(), keys)
  .then(function (percentages) {
    var i = 0
    var deferreds = []
    var output
    var percentage
    for (var modName in modifiers) {
      percentage = percentages[i++]
      // Redis stringifies everything, so ranges must be reified
      if (typeof percentage === 'string') {
        percentage = JSON.parse(percentage)
      }
      // in the circumstance that the key is not found, default to original value
      if (percentage === null) {
        percentage = normalizePercentageRange(modifiers[modName].percentage)
      }
      if (isPercentageInRange(likely, percentage)) {
        if (!modifiers[modName].condition) {
          modifiers[modName].condition = defaultCondition
        }
        try {
          output = modifiers[modName].condition(opt_values[modName])
        } catch (err) {
          console.warn('rollout key[' + key + '] mod[' + modName + '] condition threw:', err)
          continue
        }
        if (output) {
          if (typeof output.then === 'function') {
            // Normalize thenable to Bluebird Promise
            // Reflect the Promise to coalesce rejections
            output = Promise.resolve(output).reflect()
            output.handlerModifier = modName
            deferreds.push(output)
          } else {
            return modName
          }
        }
      }
    }
    if (deferreds.length) {
      return Promise.all(deferreds)
      .then(function (results) {
        var resultPromise, resultValue
        for (var i = 0, len = results.length; i < len; i++) {
          resultPromise = results[i]
          // Treat rejected conditions as inapplicable modifiers
          if (resultPromise.isFulfilled()) {
            resultValue = resultPromise.value()
            // Treat resolved conditions with truthy values as affirmative
            if (resultValue) {
              return deferreds[i].handlerModifier
            }
          }
        }
        return Promise.reject()
      })
    }
    throw new Error('Not inclusive of any partition for key[' + key + '] id[' + id + ']')
  })
}

Rollout.prototype.update = function (key, modifierPercentages) {
  var persistKeys = []
  var modName
  var percentage
  for (modName in modifierPercentages) {
    percentage = normalizePercentageRange(modifierPercentages[modName])
    persistKeys.push(this.generate_key(key, modName), JSON.stringify(percentage))
  }
  return setRedisKeys(this.clientFactory(), persistKeys)
}

Rollout.prototype.modifiers = function (handlerName) {
  var modifiers = this._handlers[handlerName]
  var keys = []
  var modNames = []
  var modName
  for (modName in modifiers) {
    keys.push(this.generate_key(handlerName, modName))
    modNames.push(modName)
  }
  return getRedisKeys(this.clientFactory(), keys)
  .then(function (percentages) {
    var modPercentages = {}
    var i = 0
    var percentage
    for (modName in modifiers) {
      percentage = percentages[i++]
      // Redis stringifies everything, so ranges must be reified
      if (typeof percentage === 'string') {
        percentage = JSON.parse(percentage)
      }
      // in the circumstance that the key is not found, default to original value
      if (percentage === null) {
        percentage = normalizePercentageRange(modifiers[modName].percentage)
      }
      modPercentages[modName] = percentage
    }
    return modPercentages
  })
}

Rollout.prototype.handlers = function () {
  return Promise.resolve(Object.keys(this._handlers))
}

Rollout.prototype.val_to_percent = function (text) {
  var n = crypto.createHash('md5').update(text).digest('hex')
  n = n.slice(0, n.length/2)
  return parseInt(n, 16) / parseInt(n.split('').map(function () { return 'f' }).join(''), 16) * 100
}

Rollout.prototype.generate_key = function (key, modName) {
  return (this.prefix ? this.prefix + ':' : '') + key + ':' + modName
}

function defaultCondition() {
  return true
}

function clampPercentage(val) {
  return Math.max(0, Math.min(100, +(val || 0)))
}

function normalizePercentageRange(val) {
  if (val && typeof val === 'object') {
    return {
      min: clampPercentage(val.min),
      max: clampPercentage(val.max)
    }
  }
  return clampPercentage(val)
}

function isPercentageInRange(val, range) {
  if (range && typeof range === 'object') {
    return val > range.min && val <= range.max
  }
  return val < range
}

function getRedisKeys(client, keys) {
  return new Promise(function (resolve, reject) {
    client.mget(keys, promiseCallback(resolve, reject))
  })
}

function setRedisKeys(client, keys) {
  return new Promise(function (resolve, reject) {
    client.mset(keys, promiseCallback(resolve, reject))
  })
}

function promiseCallback(resolve, reject) {
  return function (err, result) {
    if (err) {
      return reject(err)
    }
    resolve(result)
  }
}
