'use strict';

var async = require('async');
var db = require('./database');
var user = require('./user');
var groups = require('./groups');
var meta = require('./meta');
var notifications = require('./notifications');
var analytics = require('./analytics');
var topics = require('./topics');
var posts = require('./posts');
var privileges = require('./privileges');
var plugins = require('./plugins');
var utils = require('../public/src/utils');
var _ = require('underscore');
var S = require('string');

var Flags = module.exports;

Flags.get = function (flagId, callback) {
	async.waterfall([
		// First stage
		async.apply(async.parallel, {
			base: async.apply(db.getObject.bind(db), 'flag:' + flagId),
			history: async.apply(Flags.getHistory, flagId),
			notes: async.apply(Flags.getNotes, flagId),
		}),
		function (data, next) {
			if (!data.base) {
				return callback();
			}
			// Second stage
			async.parallel({
				userObj: async.apply(user.getUserFields, data.base.uid, ['username', 'userslug', 'picture', 'reputation']),
				targetObj: async.apply(Flags.getTarget, data.base.type, data.base.targetId, data.base.uid),
			}, function (err, payload) {
				// Final object return construction
				next(err, Object.assign(data.base, {
					datetimeISO: new Date(parseInt(data.base.datetime, 10)).toISOString(),
					target_readable: data.base.type.charAt(0).toUpperCase() + data.base.type.slice(1) + ' ' + data.base.targetId,
					target: payload.targetObj,
					history: data.history,
					notes: data.notes,
					reporter: payload.userObj,
				}));
			});
		},
	], callback);
};

Flags.list = function (filters, uid, callback) {
	if (typeof filters === 'function' && !uid && !callback) {
		callback = filters;
		filters = {};
	}

	var sets = [];
	var orSets = [];
	var prepareSets = function (setPrefix, value) {
		if (!Array.isArray(value)) {
			sets.push(setPrefix + value);
		} else if (value.length) {
			value.forEach(function (x) {
				orSets.push(setPrefix + x);
			});
		}
	};

	if (Object.keys(filters).length > 0) {
		for (var type in filters) {
			if (filters.hasOwnProperty(type)) {
				switch (type) {
				case 'type':
					prepareSets('flags:byType:', filters[type]);
					break;

				case 'state':
					prepareSets('flags:byState:', filters[type]);
					break;

				case 'reporterId':
					prepareSets('flags:byReporter:', filters[type]);
					break;

				case 'assignee':
					prepareSets('flags:byAssignee:', filters[type]);
					break;

				case 'targetUid':
					prepareSets('flags:byTargetUid:', filters[type]);
					break;

				case 'cid':
					prepareSets('flags:byCid:', filters[type]);
					break;

				case 'quick':
					switch (filters.quick) {
					case 'mine':
						sets.push('flags:byAssignee:' + uid);
						break;
					}
					break;
				}
			}
		}
	}
	sets = (sets.length || orSets.length) ? sets : ['flags:datetime'];	// No filter default

	async.waterfall([
		function (next) {
			if (sets.length === 1) {
				db.getSortedSetRevRange(sets[0], 0, -1, next);
			} else if (sets.length > 1) {
				db.getSortedSetRevIntersect({ sets: sets, start: 0, stop: -1, aggregate: 'MAX' }, next);
			} else {
				next(null, []);
			}
		},
		function (flagIds, next) {
			// Find flags according to "or" rules, if any
			if (orSets.length) {
				db.getSortedSetRevUnion({ sets: orSets, start: 0, stop: -1, aggregate: 'MAX' }, function (err, _flagIds) {
					if (err) {
						return next(err);
					}

					if (sets.length) {
						// If flag ids are already present, return a subset of flags that are in both sets
						next(null, _.intersection(flagIds, _flagIds));
					} else {
						// Otherwise, return all flags returned via orSets
						next(null, _.union(flagIds, _flagIds));
					}
				});
			} else {
				setImmediate(next, null, flagIds);
			}
		},
		function (flagIds, next) {
			async.map(flagIds, function (flagId, next) {
				async.waterfall([
					async.apply(db.getObject, 'flag:' + flagId),
					function (flagObj, next) {
						user.getUserFields(flagObj.uid, ['username', 'picture'], function (err, userObj) {
							next(err, Object.assign(flagObj, {
								reporter: {
									username: userObj.username,
									picture: userObj.picture,
									'icon:bgColor': userObj['icon:bgColor'],
									'icon:text': userObj['icon:text'],
								},
							}));
						});
					},
				], function (err, flagObj) {
					if (err) {
						return next(err);
					}

					switch (flagObj.state) {
					case 'open':
						flagObj.labelClass = 'info';
						break;
					case 'wip':
						flagObj.labelClass = 'warning';
						break;
					case 'resolved':
						flagObj.labelClass = 'success';
						break;
					case 'rejected':
						flagObj.labelClass = 'danger';
						break;
					}

					next(null, Object.assign(flagObj, {
						target_readable: flagObj.type.charAt(0).toUpperCase() + flagObj.type.slice(1) + ' ' + flagObj.targetId,
						datetimeISO: new Date(parseInt(flagObj.datetime, 10)).toISOString(),
					}));
				});
			}, next);
		},
	], callback);
};

Flags.validate = function (payload, callback) {
	async.parallel({
		targetExists: async.apply(Flags.targetExists, payload.type, payload.id),
		target: async.apply(Flags.getTarget, payload.type, payload.id, payload.uid),
		reporter: async.apply(user.getUserData, payload.uid),
	}, function (err, data) {
		if (err) {
			return callback(err);
		}

		if (data.target.deleted) {
			return callback(new Error('[[error:post-deleted]]'));
		} else if (parseInt(data.reporter.banned, 10)) {
			return callback(new Error('[[error:user-banned]]'));
		}

		switch (payload.type) {
		case 'post':
			privileges.posts.canEdit(payload.id, payload.uid, function (err, editable) {
				if (err) {
					return callback(err);
				}

				var minimumReputation = utils.isNumber(meta.config['privileges:flag']) ? parseInt(meta.config['privileges:flag'], 10) : 1;
					// Check if reporter meets rep threshold (or can edit the target post, in which case threshold does not apply)
				if (!editable.flag && parseInt(data.reporter.reputation, 10) < minimumReputation) {
					return callback(new Error('[[error:not-enough-reputation-to-flag]]'));
				}

				callback();
			});
			break;

		case 'user':
			privileges.users.canEdit(payload.uid, payload.id, function (err, editable) {
				if (err) {
					return callback(err);
				}

				var minimumReputation = utils.isNumber(meta.config['privileges:flag']) ? parseInt(meta.config['privileges:flag'], 10) : 1;
					// Check if reporter meets rep threshold (or can edit the target user, in which case threshold does not apply)
				if (!editable && parseInt(data.reporter.reputation, 10) < minimumReputation) {
					return callback(new Error('[[error:not-enough-reputation-to-flag]]'));
				}

				callback();
			});
			break;

		default:
			callback(new Error('[[error:invalid-data]]'));
			break;
		}
	});
};

Flags.getNotes = function (flagId, callback) {
	async.waterfall([
		async.apply(db.getSortedSetRevRangeWithScores.bind(db), 'flag:' + flagId + ':notes', 0, -1),
		function (notes, next) {
			var uids = [];
			var noteObj;
			notes = notes.map(function (note) {
				try {
					noteObj = JSON.parse(note.value);
					uids.push(noteObj[0]);
					return {
						uid: noteObj[0],
						content: noteObj[1],
						datetime: note.score,
						datetimeISO: new Date(parseInt(note.score, 10)).toISOString(),
					};
				} catch (e) {
					return next(e);
				}
			});
			next(null, notes, uids);
		},
		function (notes, uids, next) {
			user.getUsersFields(uids, ['username', 'userslug', 'picture'], function (err, users) {
				if (err) {
					return next(err);
				}

				next(null, notes.map(function (note, idx) {
					note.user = users[idx];
					return note;
				}));
			});
		},
	], callback);
};

Flags.create = function (type, id, uid, reason, timestamp, callback) {
	var targetUid;
	var targetCid;
	var doHistoryAppend = false;

	// timestamp is optional
	if (typeof timestamp === 'function' && !callback) {
		callback = timestamp;
		timestamp = Date.now();
		doHistoryAppend = true;
	}

	async.waterfall([
		function (next) {
			async.parallel([
				// Sanity checks
				async.apply(Flags.exists, type, id, uid),
				async.apply(Flags.targetExists, type, id),

				// Extra data for zset insertion
				async.apply(Flags.getTargetUid, type, id),
				async.apply(Flags.getTargetCid, type, id),
			], function (err, checks) {
				if (err) {
					return next(err);
				}

				targetUid = checks[2] || null;
				targetCid = checks[3] || null;

				if (checks[0]) {
					return next(new Error('[[error:already-flagged]]'));
				} else if (!checks[1]) {
					return next(new Error('[[error:invalid-data]]'));
				}
				next();
			});
		},
		async.apply(db.incrObjectField, 'global', 'nextFlagId'),
		function (flagId, next) {
			var tasks = [
				async.apply(db.setObject.bind(db), 'flag:' + flagId, {
					flagId: flagId,
					type: type,
					targetId: id,
					description: reason,
					uid: uid,
					datetime: timestamp,
				}),
				async.apply(db.sortedSetAdd.bind(db), 'flags:datetime', timestamp, flagId),	// by time, the default
				async.apply(db.sortedSetAdd.bind(db), 'flags:byReporter:' + uid, timestamp, flagId),	// by reporter
				async.apply(db.sortedSetAdd.bind(db), 'flags:byType:' + type, timestamp, flagId),	// by flag type
				async.apply(db.sortedSetAdd.bind(db), 'flags:hash', flagId, [type, id, uid].join(':')),	// save zset for duplicate checking
				async.apply(analytics.increment, 'flags'),	// some fancy analytics
			];

			if (targetUid) {
				tasks.push(async.apply(db.sortedSetAdd.bind(db), 'flags:byTargetUid:' + targetUid, timestamp, flagId));	// by target uid
			}
			if (targetCid) {
				tasks.push(async.apply(db.sortedSetAdd.bind(db), 'flags:byCid:' + targetCid, timestamp, flagId));	// by target cid
			}
			if (type === 'post') {
				tasks.push(async.apply(db.sortedSetAdd.bind(db), 'flags:byPid:' + id, timestamp, flagId));	// by target pid
				if (targetUid) {
					tasks.push(async.apply(db.sortedSetIncrBy.bind(db), 'users:flags', 1, targetUid));
				}
			}

			async.parallel(tasks, function (err) {
				if (err) {
					return next(err);
				}

				if (doHistoryAppend) {
					Flags.update(flagId, uid, { state: 'open' });
				}

				next(null, flagId);
			});
		},
		async.apply(Flags.get),
	], callback);
};

Flags.exists = function (type, id, uid, callback) {
	db.isSortedSetMember('flags:hash', [type, id, uid].join(':'), callback);
};

Flags.getTarget = function (type, id, uid, callback) {
	async.waterfall([
		async.apply(Flags.targetExists, type, id),
		function (exists, next) {
			if (exists) {
				switch (type) {
				case 'post':
					async.waterfall([
						async.apply(posts.getPostsByPids, [id], uid),
						function (posts, next) {
							topics.addPostData(posts, uid, next);
						},
					], function (err, posts) {
						next(err, posts[0]);
					});
					break;

				case 'user':
					user.getUsersData([id], function (err, users) {
						next(err, users ? users[0] : undefined);
					});
					break;

				default:
					next(new Error('[[error:invalid-data]]'));
					break;
				}
			} else {
				// Target used to exist (otherwise flag creation'd fail), but no longer
				next(null, {});
			}
		},
	], callback);
};

Flags.targetExists = function (type, id, callback) {
	switch (type) {
	case 'post':
		posts.exists(id, callback);
		break;

	case 'user':
		user.exists(id, callback);
		break;

	default:
		callback(new Error('[[error:invalid-data]]'));
		break;
	}
};

Flags.getTargetUid = function (type, id, callback) {
	switch (type) {
	case 'post':
		posts.getPostField(id, 'uid', callback);
		break;

	default:
		setImmediate(callback, null, id);
		break;
	}
};

Flags.getTargetCid = function (type, id, callback) {
	switch (type) {
	case 'post':
		posts.getCidByPid(id, callback);
		break;

	default:
		setImmediate(callback, null, id);
		break;
	}
};

Flags.update = function (flagId, uid, changeset, callback) {
	// Retrieve existing flag data to compare for history-saving purposes
	var fields = ['state', 'assignee'];
	var tasks = [];
	var now = changeset.datetime || Date.now();
	var notifyAssignee = function (assigneeId, next) {
		if (assigneeId === '') {
			// Do nothing
			return next();
		}
		// Notify assignee of this update
		notifications.create({
			type: 'my-flags',
			bodyShort: '[[notifications:flag_assigned_to_you, ' + flagId + ']]',
			bodyLong: '',
			path: '/flags/' + flagId,
			nid: 'flags:assign:' + flagId + ':uid:' + assigneeId,
			from: uid,
		}, function (err, notification) {
			if (err || !notification) {
				return next(err);
			}

			notifications.push(notification, [assigneeId], next);
		});
	};

	async.waterfall([
		async.apply(db.getObjectFields.bind(db), 'flag:' + flagId, fields),
		function (current, next) {
			for (var prop in changeset) {
				if (changeset.hasOwnProperty(prop)) {
					if (current[prop] === changeset[prop]) {
						delete changeset[prop];
					} else {
						// Add tasks as necessary
						switch (prop) {
						case 'state':
							tasks.push(async.apply(db.sortedSetAdd.bind(db), 'flags:byState:' + changeset[prop], now, flagId));
							tasks.push(async.apply(db.sortedSetRemove.bind(db), 'flags:byState:' + current[prop], flagId));
							break;

						case 'assignee':
							tasks.push(async.apply(db.sortedSetAdd.bind(db), 'flags:byAssignee:' + changeset[prop], now, flagId));
							tasks.push(async.apply(notifyAssignee, changeset[prop]));
							break;
						}
					}
				}
			}

			if (!Object.keys(changeset).length) {
				// No changes
				return next();
			}

			// Save new object to db (upsert)
			tasks.push(async.apply(db.setObject, 'flag:' + flagId, changeset));

			// Append history
			tasks.push(async.apply(Flags.appendHistory, flagId, uid, changeset));

			// Fire plugin hook
			tasks.push(async.apply(plugins.fireHook, 'action:flag.update', { flagId: flagId, changeset: changeset, uid: uid }));

			async.parallel(tasks, function (err) {
				return next(err);
			});
		},
	], callback);
};

Flags.getHistory = function (flagId, callback) {
	var history;
	var uids = [];
	async.waterfall([
		async.apply(db.getSortedSetRevRangeWithScores.bind(db), 'flag:' + flagId + ':history', 0, -1),
		function (_history, next) {
			history = _history.map(function (entry) {
				try {
					entry.value = JSON.parse(entry.value);
				} catch (e) {
					return callback(e);
				}

				uids.push(entry.value[0]);

				// Deserialise changeset
				var changeset = entry.value[1];
				if (changeset.hasOwnProperty('state')) {
					changeset.state = changeset.state === undefined ? '' : '[[flags:state-' + changeset.state + ']]';
				}

				return {
					uid: entry.value[0],
					fields: changeset,
					datetime: entry.score,
					datetimeISO: new Date(parseInt(entry.score, 10)).toISOString(),
				};
			});

			user.getUsersFields(uids, ['username', 'userslug', 'picture'], next);
		},
	], function (err, users) {
		if (err) {
			return callback(err);
		}

		// Append user data to each history event
		history = history.map(function (event, idx) {
			event.user = users[idx];
			return event;
		});

		callback(null, history);
	});
};

Flags.appendHistory = function (flagId, uid, changeset, callback) {
	var payload;
	var datetime = changeset.datetime || Date.now();
	delete changeset.datetime;

	try {
		payload = JSON.stringify([uid, changeset, datetime]);
	} catch (e) {
		return callback(e);
	}

	db.sortedSetAdd('flag:' + flagId + ':history', datetime, payload, callback);
};

Flags.appendNote = function (flagId, uid, note, datetime, callback) {
	if (typeof datetime === 'function' && !callback) {
		callback = datetime;
		datetime = Date.now();
	}

	var payload;
	try {
		payload = JSON.stringify([uid, note]);
	} catch (e) {
		return callback(e);
	}

	async.waterfall([
		async.apply(db.sortedSetAdd, 'flag:' + flagId + ':notes', datetime, payload),
		async.apply(Flags.appendHistory, flagId, uid, {
			notes: null,
			datetime: datetime,
		}),
	], callback);
};

Flags.notify = function (flagObj, uid, callback) {
	// Notify administrators, mods, and other associated people
	if (!callback) {
		callback = function () {};
	}

	switch (flagObj.type) {
	case 'post':
		async.parallel({
			post: function (next) {
				async.waterfall([
					async.apply(posts.getPostData, flagObj.targetId),
					async.apply(posts.parsePost),
				], next);
			},
			title: async.apply(topics.getTitleByPid, flagObj.targetId),
			admins: async.apply(groups.getMembers, 'administrators', 0, -1),
			globalMods: async.apply(groups.getMembers, 'Global Moderators', 0, -1),
			moderators: function (next) {
				async.waterfall([
					async.apply(posts.getCidByPid, flagObj.targetId),
					function (cid, next) {
						groups.getMembers('cid:' + cid + ':privileges:mods', 0, -1, next);
					},
				], next);
			},
		}, function (err, results) {
			if (err) {
				return callback(err);
			}

			var title = S(results.title).decodeHTMLEntities().s;
			var titleEscaped = title.replace(/%/g, '&#37;').replace(/,/g, '&#44;');

			notifications.create({
				type: 'new-post-flag',
				bodyShort: '[[notifications:user_flagged_post_in, ' + flagObj.reporter.username + ', ' + titleEscaped + ']]',
				bodyLong: flagObj.description,
				pid: flagObj.targetId,
				path: '/post/' + flagObj.targetId,
				nid: 'flag:post:' + flagObj.targetId + ':uid:' + uid,
				from: uid,
				mergeId: 'notifications:user_flagged_post_in|' + flagObj.targetId,
				topicTitle: results.title,
			}, function (err, notification) {
				if (err || !notification) {
					return callback(err);
				}

				plugins.fireHook('action:flag.create', {
					flag: flagObj,
				});
				notifications.push(notification, results.admins.concat(results.moderators).concat(results.globalMods), callback);
			});
		});
		break;

	case 'user':
		async.parallel({
			admins: async.apply(groups.getMembers, 'administrators', 0, -1),
			globalMods: async.apply(groups.getMembers, 'Global Moderators', 0, -1),
		}, function (err, results) {
			if (err) {
				return callback(err);
			}

			notifications.create({
				bodyShort: '[[notifications:user_flagged_user, ' + flagObj.reporter.username + ', ' + flagObj.target.username + ']]',
				bodyLong: flagObj.description,
				path: '/uid/' + flagObj.targetId,
				nid: 'flag:user:' + flagObj.targetId + ':uid:' + uid,
				from: uid,
				mergeId: 'notifications:user_flagged_user|' + flagObj.targetId,
			}, function (err, notification) {
				if (err || !notification) {
					return callback(err);
				}

				plugins.fireHook('action:flag.create', {
					flag: flagObj,
				});
				notifications.push(notification, results.admins.concat(results.globalMods), callback);
			});
		});
		break;

	default:
		callback(new Error('[[error:invalid-data]]'));
		break;
	}
};
