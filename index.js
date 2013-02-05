var Backbone = {};
var _ = require('underscore');
var Events = require('events');
Backbone.wrapError = require('backbone-wrap-error');

// Backbone.Model
// --------------

// Create a new model, with defined attributes. A client id (`cid`)
// is automatically generated and assigned for you.
var Model = function(attributes, options) {
  var defaults;
  attributes || (attributes = {});
  if (options && options.collection) this.collection = options.collection;
  if (options && options.parse) attributes = this.parse(attributes);
  if (defaults = getValue(this, 'defaults')) {
    attributes = _.extend({}, defaults, attributes);
  }
  this.attributes = {};
  this._escapedAttributes = {};
  this.cid = _.uniqueId('c');
  this.changed = {};
  this._silent = {};
  this._pending = {};
  this.set(attributes, {silent: true});
  // Reset change tracking.
  this.changed = {};
  this._silent = {};
  this._pending = {};
  this._previousAttributes = _.clone(this.attributes);
  this.initialize.apply(this, arguments);
};

// Attach all inheritable methods to the Model prototype.
_.extend(Model.prototype, Events, {

  // A hash of attributes whose current and previous value differ.
  changed: null,

  // A hash of attributes that have silently changed since the last time
  // `change` was called.  Will become pending attributes on the next call.
  _silent: null,

  // A hash of attributes that have changed since the last `'change'` event
  // began.
  _pending: null,

  // The default name for the JSON `id` attribute is `"id"`. MongoDB and
  // CouchDB users may want to set this to `"_id"`.
  idAttribute: 'id',

  // Initialize is an empty function by default. Override it with your own
  // initialization logic.
  initialize: function(){},

  // Return a copy of the model's `attributes` object.
  toJSON: function(options) {
    return _.clone(this.attributes);
  },

  // Proxy `Backbone.sync` by default.
  sync: function() {
    return Backbone.sync.apply(this, arguments);
  },

  // Get the value of an attribute.
  get: function(attr) {
    return this.attributes[attr];
  },

  // Get the HTML-escaped value of an attribute.
  escape: function(attr) {
    var html;
    if (html = this._escapedAttributes[attr]) return html;
    var val = this.get(attr);
    return this._escapedAttributes[attr] = _.escape(val == null ? '' : '' + val);
  },

  // Returns `true` if the attribute contains a value that is not null
  // or undefined.
  has: function(attr) {
    return this.get(attr) != null;
  },

  // Set a hash of model attributes on the object, firing `"change"` unless
  // you choose to silence it.
  set: function(key, value, options) {
    var attrs, attr, val;

    // Handle both `"key", value` and `{key: value}` -style arguments.
    if (_.isObject(key) || key == null) {
      attrs = key;
      options = value;
    } else {
      attrs = {};
      attrs[key] = value;
    }

    // Extract attributes and options.
    options || (options = {});
    if (!attrs) return this;
    if (attrs instanceof Model) attrs = attrs.attributes;
    if (options.unset) for (attr in attrs) attrs[attr] = void 0;

    // Run validation.
    if (!this._validate(attrs, options)) return false;

    // Check for changes of `id`.
    if (this.idAttribute in attrs) this.id = attrs[this.idAttribute];

    var changes = options.changes = {};
    var now = this.attributes;
    var escaped = this._escapedAttributes;
    var prev = this._previousAttributes || {};

    // For each `set` attribute...
    for (attr in attrs) {
      val = attrs[attr];

      // If the new and current value differ, record the change.
      if (!_.isEqual(now[attr], val) || (options.unset && _.has(now, attr))) {
        delete escaped[attr];
        (options.silent ? this._silent : changes)[attr] = true;
      }

      // Update or delete the current value.
      options.unset ? delete now[attr] : now[attr] = val;

      // If the new and previous value differ, record the change.  If not,
      // then remove changes for this attribute.
      if (!_.isEqual(prev[attr], val) || (_.has(now, attr) !== _.has(prev, attr))) {
        this.changed[attr] = val;
        if (!options.silent) this._pending[attr] = true;
      } else {
        delete this.changed[attr];
        delete this._pending[attr];
      }
    }

    // Fire the `"change"` events.
    if (!options.silent) this.change(options);
    return this;
  },

  // Remove an attribute from the model, firing `"change"` unless you choose
  // to silence it. `unset` is a noop if the attribute doesn't exist.
  unset: function(attr, options) {
    options = _.extend({}, options, {unset: true});
    return this.set(attr, null, options);
  },

  // Clear all attributes on the model, firing `"change"` unless you choose
  // to silence it.
  clear: function(options) {
    options = _.extend({}, options, {unset: true});
    return this.set(_.clone(this.attributes), options);
  },

  // Fetch the model from the server. If the server's representation of the
  // model differs from its current attributes, they will be overriden,
  // triggering a `"change"` event.
  fetch: function(options) {
    options = options ? _.clone(options) : {};
    var model = this;
    var success = options.success;
    options.success = function(resp, status, xhr) {
      if (!model.set(model.parse(resp, xhr), options)) return false;
      if (success) success(model, resp, options);
      model.trigger('sync', model, resp, options);
    };
    options.error = Backbone.wrapError(options.error, model, options);
    return this.sync('read', this, options);
  },

  // Set a hash of model attributes, and sync the model to the server.
  // If the server returns an attributes hash that differs, the model's
  // state will be `set` again.
  save: function(key, value, options) {
    var attrs, current, done;

    // Handle both `("key", value)` and `({key: value})` -style calls.
    if (_.isObject(key) || key == null) {
      attrs = key;
      options = value;
    } else {
      attrs = {};
      attrs[key] = value;
    }
    options = options ? _.clone(options) : {};

    // If we're "wait"-ing to set changed attributes, validate early.
    if (options.wait) {
      if (!this._validate(attrs, options)) return false;
      current = _.clone(this.attributes);
    }

    // Regular saves `set` attributes before persisting to the server.
    var silentOptions = _.extend({}, options, {silent: true});
    if (attrs && !this.set(attrs, options.wait ? silentOptions : options)) {
      return false;
    }

    // Do not persist invalid models.
    if (!attrs && !this.isValid()) return false;

    // After a successful server-side save, the client is (optionally)
    // updated with the server-side state.
    var model = this;
    var success = options.success;
    options.success = function(resp, status, xhr) {
      done = true;
      var serverAttrs = model.parse(resp, xhr);
      if (options.wait) serverAttrs = _.extend(attrs || {}, serverAttrs);
      if (!model.set(serverAttrs, options)) return false;
      if (success) success(model, resp, options);
      model.trigger('sync', model, resp, options);
    };

    // Finish configuring and sending the Ajax request.
    options.error = Backbone.wrapError(options.error, model, options);
    var xhr = this.sync(this.isNew() ? 'create' : 'update', this, options);

    // When using `wait`, reset attributes to original values unless
    // `success` has been called already.
    if (!done && options.wait) {
      this.clear(silentOptions);
      this.set(current, silentOptions);
    }

    return xhr;
  },

  // Destroy this model on the server if it was already persisted.
  // Optimistically removes the model from its collection, if it has one.
  // If `wait: true` is passed, waits for the server to respond before removal.
  destroy: function(options) {
    options = options ? _.clone(options) : {};
    var model = this;
    var success = options.success;

    var destroy = function() {
      model.trigger('destroy', model, model.collection, options);
    };

    options.success = function(resp) {
      if (options.wait || model.isNew()) destroy();
      if (success) success(model, resp, options);
      if (!model.isNew()) model.trigger('sync', model, resp, options);
    };

    if (this.isNew()) {
      options.success();
      return false;
    }

    options.error = Backbone.wrapError(options.error, model, options);
    var xhr = this.sync('delete', this, options);
    if (!options.wait) destroy();
    return xhr;
  },

  // Default URL for the model's representation on the server -- if you're
  // using Backbone's restful methods, override this to change the endpoint
  // that will be called.
  url: function() {
    var base = getValue(this, 'urlRoot') || getValue(this.collection, 'url') || urlError();
    if (this.isNew()) return base;
    return base + (base.charAt(base.length - 1) === '/' ? '' : '/') + encodeURIComponent(this.id);
  },

  // **parse** converts a response into the hash of attributes to be `set` on
  // the model. The default implementation is just to pass the response along.
  parse: function(resp, xhr) {
    return resp;
  },

  // Create a new model with identical attributes to this one.
  clone: function() {
    return new this.constructor(this.attributes);
  },

  // A model is new if it has never been saved to the server, and lacks an id.
  isNew: function() {
    return this.id == null;
  },

  // Call this method to manually fire a `"change"` event for this model and
  // a `"change:attribute"` event for each changed attribute.
  // Calling this will cause all objects observing the model to update.
  change: function(options) {
    options || (options = {});
    var changing = this._changing;
    this._changing = true;

    // Silent changes become pending changes.
    for (var attr in this._silent) this._pending[attr] = true;

    // Silent changes are triggered.
    var changes = _.extend({}, options.changes, this._silent);
    this._silent = {};
    for (var attr in changes) {
      this.trigger('change:' + attr, this, this.get(attr), options);
    }
    if (changing) return this;

    // Continue firing `"change"` events while there are pending changes.
    while (!_.isEmpty(this._pending)) {
      this._pending = {};
      this.trigger('change', this, options);
      // Pending and silent changes still remain.
      for (var attr in this.changed) {
        if (this._pending[attr] || this._silent[attr]) continue;
        delete this.changed[attr];
      }
      this._previousAttributes = _.clone(this.attributes);
    }

    this._changing = false;
    return this;
  },

  // Determine if the model has changed since the last `"change"` event.
  // If you specify an attribute name, determine if that attribute has changed.
  hasChanged: function(attr) {
    if (attr == null) return !_.isEmpty(this.changed);
    return _.has(this.changed, attr);
  },

  // Return an object containing all the attributes that have changed, or
  // false if there are no changed attributes. Useful for determining what
  // parts of a view need to be updated and/or what attributes need to be
  // persisted to the server. Unset attributes will be set to undefined.
  // You can also pass an attributes object to diff against the model,
  // determining if there *would be* a change.
  changedAttributes: function(diff) {
    if (!diff) return this.hasChanged() ? _.clone(this.changed) : false;
    var val, changed = false, old = this._previousAttributes;
    for (var attr in diff) {
      if (_.isEqual(old[attr], (val = diff[attr]))) continue;
      (changed || (changed = {}))[attr] = val;
    }
    return changed;
  },

  // Get the previous value of an attribute, recorded at the time the last
  // `"change"` event was fired.
  previous: function(attr) {
    if (attr == null || !this._previousAttributes) return null;
    return this._previousAttributes[attr];
  },

  // Get all of the attributes of the model at the time of the previous
  // `"change"` event.
  previousAttributes: function() {
    return _.clone(this._previousAttributes);
  },

  // Check if the model is currently in a valid state. It's only possible to
  // get into an *invalid* state if you're using silent changes.
  isValid: function() {
    return !this.validate || !this.validate(this.attributes);
  },

  // Run validation against the next complete set of model attributes,
  // returning `true` if all is well. If a specific `error` callback has
  // been passed, call that instead of firing the general `"error"` event.
  _validate: function(attrs, options) {
    if (options.silent || !this.validate) return true;
    attrs = _.extend({}, this.attributes, attrs);
    var error = this.validate(attrs, options);
    if (!error) return true;
    if (options && options.error) {
      options.error(this, error, options);
    } else {
      this.trigger('error', this, error, options);
    }
    return false;
  }

});

module.exports = Model;
