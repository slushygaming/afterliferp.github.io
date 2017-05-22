'use strict';


define('forum/notifications', ['components', 'notifications'], function (components, notifs) {
	var Notifications = {};

	Notifications.init = function () {
		var listEl = $('.notifications-list');
		listEl.on('click', '[component="notifications/item/link"]', function () {
			var nid = $(this).parents('[data-nid]').attr('data-nid');
			socket.emit('notifications.markRead', nid, function (err) {
				if (err) {
					return app.alertError(err);
				}

				socket.emit('notifications.getCount', function (err, count) {
					if (err) {
						return app.alertError(err.message);
					}

					notifs.updateNotifCount(count);
				});
			});
		});

		$('.timeago').timeago();

		components.get('notifications/mark_all').on('click', function () {
			socket.emit('notifications.markAllRead', function (err) {
				if (err) {
					return app.alertError(err.message);
				}

				components.get('notifications/item').removeClass('unread');
				notifs.updateNotifCount(0);
			});
		});
	};

	return Notifications;
});
