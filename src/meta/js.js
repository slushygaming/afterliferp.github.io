'use strict';

var path = require('path');
var async = require('async');
var fs = require('fs');
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');

var file = require('../file');
var plugins = require('../plugins');
var minifier = require('./minifier');

module.exports = function (Meta) {
	Meta.js = {};

	Meta.js.scripts = {
		base: [
			'node_modules/jquery/dist/jquery.js',
			'node_modules/socket.io-client/dist/socket.io.js',
			'public/vendor/jquery/timeago/jquery.timeago.js',
			'public/vendor/jquery/js/jquery.form.min.js',
			'public/vendor/visibility/visibility.min.js',
			'node_modules/bootstrap/dist/js/bootstrap.js',
			'public/vendor/jquery/bootstrap-tagsinput/bootstrap-tagsinput.min.js',
			'public/vendor/jquery/textcomplete/jquery.textcomplete.js',
			'public/vendor/requirejs/require.js',
			'public/src/require-config.js',
			'public/vendor/bootbox/bootbox.js',
			'public/vendor/bootbox/wrapper.js',
			'public/vendor/tinycon/tinycon.js',
			'public/vendor/xregexp/xregexp.js',
			'public/vendor/xregexp/unicode/unicode-base.js',
			'node_modules/templates.js/lib/templates.js',
			'public/src/utils.js',
			'public/src/sockets.js',
			'public/src/app.js',
			'public/src/ajaxify.js',
			'public/src/overrides.js',
			'public/src/widgets.js',
			'node_modules/promise-polyfill/promise.js',
		],

		// files listed below are only available client-side, or are bundled in to reduce # of network requests on cold load
		rjs: [
			'public/src/client/footer.js',
			'public/src/client/chats.js',
			'public/src/client/infinitescroll.js',
			'public/src/client/pagination.js',
			'public/src/client/recent.js',
			'public/src/client/unread.js',
			'public/src/client/topic.js',
			'public/src/client/topic/events.js',
			'public/src/client/topic/fork.js',
			'public/src/client/topic/move.js',
			'public/src/client/topic/posts.js',
			'public/src/client/topic/images.js',
			'public/src/client/topic/postTools.js',
			'public/src/client/topic/threadTools.js',
			'public/src/client/categories.js',
			'public/src/client/category.js',
			'public/src/client/category/tools.js',

			'public/src/modules/translator.js',
			'public/src/modules/notifications.js',
			'public/src/modules/chat.js',
			'public/src/modules/components.js',
			'public/src/modules/sort.js',
			'public/src/modules/navigator.js',
			'public/src/modules/topicSelect.js',
			'public/src/modules/share.js',
			'public/src/modules/search.js',
			'public/src/modules/alerts.js',
			'public/src/modules/taskbar.js',
			'public/src/modules/helpers.js',
			'public/src/modules/string.js',
			'public/src/modules/flags.js',
			'public/src/modules/storage.js',
		],

		// modules listed below are built (/src/modules) so they can be defined anonymously
		modules: {
			'Chart.js': 'node_modules/chart.js/dist/Chart.min.js',
			'mousetrap.js': 'node_modules/mousetrap/mousetrap.min.js',
			'cropper.js': 'node_modules/cropperjs/dist/cropper.min.js',
			'jqueryui.js': 'public/vendor/jquery/js/jquery-ui.js',
			'zxcvbn.js': 'node_modules/zxcvbn/dist/zxcvbn.js',
			ace: 'node_modules/ace-builds/src-min',
		},
	};

	function minifyModules(modules, fork, callback) {
		// for it to never fork
		// otherwise it spawns way too many processes
		// maybe eventually we can pool modules
		// and pass the pools to the minifer
		// to reduce the total number of threads
		fork = false;

		async.eachLimit(modules, 500, function (mod, next) {
			var srcPath = mod.srcPath;
			var destPath = mod.destPath;

			async.parallel({
				dirped: function (cb) {
					mkdirp(path.dirname(destPath), cb);
				},
				minified: function (cb) {
					fs.readFile(srcPath, function (err, buffer) {
						if (err) {
							return cb(err);
						}

						if (srcPath.endsWith('.min.js') || path.dirname(srcPath).endsWith('min')) {
							return cb(null, { code: buffer.toString() });
						}

						minifier.js.minify(buffer.toString(), fork, cb);
					});
				},
			}, function (err, results) {
				if (err) {
					return next(err);
				}

				var minified = results.minified;
				fs.writeFile(destPath, minified.code, next);
			});
		}, callback);
	}

	function linkModules(callback) {
		var modules = Meta.js.scripts.modules;

		async.eachLimit(Object.keys(modules), 1000, function (relPath, next) {
			var srcPath = path.join(__dirname, '../../', modules[relPath]);
			var destPath = path.join(__dirname, '../../build/public/src/modules', relPath);

			async.parallel({
				dir: function (cb) {
					mkdirp(path.dirname(destPath), function (err) {
						cb(err);
					});
				},
				stats: function (cb) {
					fs.stat(srcPath, cb);
				},
			}, function (err, res) {
				if (err) {
					return next(err);
				}
				if (res.stats.isDirectory()) {
					return file.linkDirs(srcPath, destPath, next);
				}

				file.link(srcPath, destPath, next);
			});
		}, callback);
	}

	var moduleDirs = ['modules', 'admin', 'client'];

	function getModuleList(callback) {
		var modules = Object.keys(Meta.js.scripts.modules).map(function (relPath) {
			return {
				srcPath: path.join(__dirname, '../../', Meta.js.scripts.modules[relPath]),
				destPath: path.join(__dirname, '../../build/public/src/modules', relPath),
			};
		});

		var coreDirs = moduleDirs.map(function (dir) {
			return {
				srcPath: path.join(__dirname, '../../public/src', dir),
				destPath: path.join(__dirname, '../../build/public/src', dir),
			};
		});

		modules = modules.concat(coreDirs);

		var moduleFiles = [];
		async.eachLimit(modules, 1000, function (module, next) {
			var srcPath = module.srcPath;
			var destPath = module.destPath;

			fs.stat(srcPath, function (err, stats) {
				if (err) {
					return next(err);
				}
				if (!stats.isDirectory()) {
					moduleFiles.push(module);
					return next();
				}

				file.walk(srcPath, function (err, files) {
					if (err) {
						return next(err);
					}

					var mods = files.filter(function (filePath) {
						return path.extname(filePath) === '.js';
					}).map(function (filePath) {
						return {
							srcPath: path.normalize(filePath),
							destPath: path.join(destPath, path.relative(srcPath, filePath)),
						};
					});

					moduleFiles = moduleFiles.concat(mods);

					next();
				});
			});
		}, function (err) {
			callback(err, moduleFiles);
		});
	}

	function clearModules(callback) {
		var builtPaths = moduleDirs.map(function (p) {
			return path.join(__dirname, '../../build/public/src', p);
		});
		async.each(builtPaths, function (builtPath, next) {
			rimraf(builtPath, next);
		}, function (err) {
			callback(err);
		});
	}

	Meta.js.buildModules = function (fork, callback) {
		async.waterfall([
			clearModules,
			function (next) {
				if (global.env === 'development') {
					return linkModules(callback);
				}

				getModuleList(next);
			},
			function (modules, next) {
				minifyModules(modules, fork, next);
			},
		], callback);
	};

	Meta.js.linkStatics = function (callback) {
		rimraf(path.join(__dirname, '../../build/public/plugins'), function (err) {
			if (err) {
				return callback(err);
			}
			async.eachLimit(Object.keys(plugins.staticDirs), 1000, function (mappedPath, next) {
				var sourceDir = plugins.staticDirs[mappedPath];
				var destDir = path.join(__dirname, '../../build/public/plugins', mappedPath);

				mkdirp(path.dirname(destDir), function (err) {
					if (err) {
						return next(err);
					}

					file.linkDirs(sourceDir, destDir, next);
				});
			}, callback);
		});
	};

	function getBundleScriptList(target, callback) {
		var pluginDirectories = [];

		if (target === 'admin') {
			target = 'acp';
		}
		var pluginScripts = plugins[target + 'Scripts'].filter(function (path) {
			if (path.endsWith('.js')) {
				return true;
			}

			pluginDirectories.push(path);
			return false;
		});

		async.each(pluginDirectories, function (directory, next) {
			file.walk(directory, function (err, scripts) {
				if (err) {
					return next(err);
				}

				pluginScripts = pluginScripts.concat(scripts);
				next();
			});
		}, function (err) {
			if (err) {
				return callback(err);
			}

			var basePath = path.resolve(__dirname, '../..');

			var scripts = Meta.js.scripts.base.concat(pluginScripts);

			if (target === 'client' && global.env !== 'development') {
				scripts = scripts.concat(Meta.js.scripts.rjs);
			}

			scripts = scripts.map(function (script) {
				return path.resolve(basePath, script).replace(/\\/g, '/');
			});

			callback(null, scripts);
		});
	}

	Meta.js.buildBundle = function (target, fork, callback) {
		var fileNames = {
			client: 'nodebb.min.js',
			admin: 'acp.min.js',
		};

		async.waterfall([
			function (next) {
				getBundleScriptList(target, next);
			},
			function (files, next) {
				var minify = global.env !== 'development';

				minifier.js.bundle(files, minify, fork, next);
			},
			function (bundle, next) {
				var filePath = path.join(__dirname, '../../build/public', fileNames[target]);
				fs.writeFile(filePath, bundle.code, next);
			},
		], callback);
	};

	Meta.js.killMinifier = function () {
		minifier.killAll();
	};
};
