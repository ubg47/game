(function () {
    window.__gpChatLiveQueue = window.__gpChatLiveQueue || [];
    window.__gpChatUnityPendingStrings = window.__gpChatUnityPendingStrings || [];
    window.__gpChatDeliveredIds = window.__gpChatDeliveredIds || {};

    function gpChatExtractMessageId(message) {
        if (!message) return "";
        if (message.id != null) return String(message.id);
        if (message.messageId != null) return String(message.messageId);
        return "";
    }

    function gpChatChannelMatches(message) {
        var ch = window.__gpChatResolvedChannelId;
        if (ch == null || !message || message.channelId == null) return true;
        return String(message.channelId) === String(ch);
    }

    window.__gpChatResolveSenderName = function (message) {
        // Админка GamePush: authorId = 0 → всегда Admin (не подставлять Яндекс/GP ник).
        if (message && message.authorId != null && String(message.authorId) === "0")
            return "Admin";
        if (message && message.player && message.player.name)
            return String(message.player.name);
        if (window.gp && window.gp.player && message && message.authorId != null &&
            String(message.authorId) === String(window.gp.player.id) && window.gp.player.name)
            return String(window.gp.player.name);
        return "Player";
    };

    window.__gpChatFlushLiveQueue = function () {
        var q = window.__gpChatLiveQueue || [];
        window.__gpChatLiveQueue = [];
        for (var i = 0; i < q.length; i++) {
            var e = q[i];
            if (!e || !e.t || !e.p)
                continue;
            if (e.t === "msg") {
                window.__gpChatUnityPendingStrings.push(e.p);
                if (window.__gpChatUnityGameObject && typeof SendMessage === "function") {
                    try { SendMessage(window.__gpChatUnityGameObject, "OnGamePushMessage", e.p); } catch (err) {}
                }
            } else if (e.t === "del") {
                if (window.__gpChatUnityGameObject && typeof SendMessage === "function") {
                    try { SendMessage(window.__gpChatUnityGameObject, "OnGamePushMessageDeleted", e.p); } catch (err) {}
                }
            }
        }
    };

    window.__gpChatForwardDeleteToUnity = function (message) {
        var mid = gpChatExtractMessageId(message);
        if (mid)
            delete window.__gpChatDeliveredIds[mid];
        if (!gpChatChannelMatches(message))
            return;

        var payload = JSON.stringify({
            messageId: mid,
            channelId: message && message.channelId != null ? String(message.channelId) : "",
            authorId: message && message.authorId != null ? String(message.authorId) : ""
        });

        if (window.__gpChatUnityGameObject && typeof SendMessage === "function")
            SendMessage(window.__gpChatUnityGameObject, "OnGamePushMessageDeleted", payload);
        else
            window.__gpChatLiveQueue.push({ t: "del", p: payload });
    };

    function gpChatMessageUnixMs(message) {
        if (!message || !message.createdAt)
            return Date.now();
        var t = new Date(message.createdAt).getTime();
        return Number.isFinite(t) ? t : Date.now();
    }

    window.__GP_CHAT_MESSAGE_TTL_MS = 5 * 60 * 1000;
    window.__gpChatTtlDeleteTimers = window.__gpChatTtlDeleteTimers || {};

    window.__gpChatIsMessageExpired = function (message) {
        var ms = gpChatMessageUnixMs(message);
        return Date.now() - ms >= window.__GP_CHAT_MESSAGE_TTL_MS;
    };

    window.__gpChatDeleteMessageNow = async function (message) {
        try {
            if (!window.gp || !window.gp.channels || !window.gp.channels.deleteMessage)
                return;
            var cid = window.__gpChatResolvedChannelId;
            if (cid == null && message && message.channelId != null)
                cid = message.channelId;
            if (cid == null)
                return;
            var mid = gpChatExtractMessageId(message);
            if (!mid)
                return;
            var midNum = parseInt(mid, 10);
            var messageId = Number.isFinite(midNum) && String(midNum) === mid ? midNum : mid;
            await window.gp.channels.deleteMessage({
                channelId: cid,
                messageId: messageId
            });
        } catch (err) {
            console.warn("[GPChat] ttl deleteMessage failed", err);
        }
    };

    // Sender schedules server delete so late joiners don't see stale history.
    window.__gpChatScheduleMessageTtlDelete = function (message) {
        try {
            if (!message)
                return;
            var mid = gpChatExtractMessageId(message);
            if (!mid)
                return;
            if (window.__gpChatTtlDeleteTimers[mid])
                return;
            // Only own messages (or admin id 0) — players usually can't delete others.
            var localId = window.gp && window.gp.player && window.gp.player.id != null
                ? String(window.gp.player.id)
                : "";
            var author = message.authorId != null ? String(message.authorId) : "";
            if (localId && author && author !== localId && author !== "0")
                return;

            var age = Date.now() - gpChatMessageUnixMs(message);
            var wait = Math.max(0, window.__GP_CHAT_MESSAGE_TTL_MS - age);
            window.__gpChatTtlDeleteTimers[mid] = setTimeout(function () {
                delete window.__gpChatTtlDeleteTimers[mid];
                window.__gpChatDeleteMessageNow(message);
            }, wait);
        } catch (e) {}
    };

    window.__gpChatForwardToUnity = function (message, historyReplay) {
        if (!message || !message.text)
            return;
        if (!gpChatChannelMatches(message))
            return;

        if (window.__gpChatIsMessageExpired(message)) {
            // Не показываем просроченные; пытаемся убрать с сервера если это наше.
            window.__gpChatDeleteMessageNow(message);
            return;
        }

        window.__gpChatScheduleMessageTtlDelete(message);

        var payload = JSON.stringify({
            messageId: gpChatExtractMessageId(message),
            senderId: message.authorId != null ? String(message.authorId) : "remote",
            senderName: window.__gpChatResolveSenderName(message),
            text: String(message.text),
            unixTimeMs: gpChatMessageUnixMs(message),
            historyReplay: historyReplay ? 1 : 0
        });

        window.__gpChatUnityPendingStrings.push(payload);

        if (window.__gpChatUnityGameObject && typeof SendMessage === "function") {
            try {
                SendMessage(window.__gpChatUnityGameObject, "OnGamePushMessage", payload);
            } catch (e) {
                console.warn("[GPChat] SendMessage failed", e);
            }
        } else {
            window.__gpChatLiveQueue.push({ t: "msg", p: payload });
        }
    };

    window.__gpChatDeliverHistoryMessage = function (message) {
        if (!message)
            return;
        window.__gpChatForwardToUnity(message, true);
    };

    window.__gpChatDeliverMessage = function (message) {
        if (!message)
            return;
        var id = gpChatExtractMessageId(message);
        if (id && window.__gpChatDeliveredIds[id])
            return;
        window.__gpChatForwardToUnity(message, false);
        if (id)
            window.__gpChatDeliveredIds[id] = 1;
    };

    window.__gpChatEnsureHandlers = function () {
        if (!window.gp || !window.gp.channels || !window.gp.channels.on)
            return false;
        if (window.__gpChatHandlersInstalled)
            return true;
        window.__gpChatHandlersInstalled = true;

        window.gp.channels.on("event:message", function (m) {
            try { window.__gpChatDeliverMessage(m); } catch (e) { console.warn("[GPChat] event:message", e); }
        });
        window.gp.channels.on("sendMessage", function (m) {
            try { window.__gpChatDeliverMessage(m); } catch (e) { console.warn("[GPChat] sendMessage", e); }
        });
        window.gp.channels.on("event:deleteMessage", function (m) {
            try { window.__gpChatForwardDeleteToUnity(m); } catch (e) { console.warn("[GPChat] event:deleteMessage", e); }
        });
        window.gp.channels.on("deleteMessage", function (m) {
            try { window.__gpChatForwardDeleteToUnity(m); } catch (e) { console.warn("[GPChat] deleteMessage", e); }
        });

        var muteEventHandler = function (mute, isMuted) {
            try {
                var ch = window.__gpChatResolvedChannelId;
                if (ch != null && mute && mute.channelId != null &&
                    String(mute.channelId) !== String(ch))
                    return;
                if (!window.__gpChatUnityGameObject || typeof SendMessage !== "function")
                    return;
                var payload = JSON.stringify({
                    channelId: mute && mute.channelId != null ? String(mute.channelId) : "",
                    playerId: mute && mute.playerId != null ? String(mute.playerId) : "",
                    unmuteAt: mute && mute.unmuteAt ? String(mute.unmuteAt) : "",
                    isMuted: !!isMuted
                });
                SendMessage(window.__gpChatUnityGameObject, "OnGamePushPlayerMute", payload);
            } catch (e) {
                console.warn("[GPChat] mute event", e);
            }
        };
        window.gp.channels.on("event:mute", function (mute) { muteEventHandler(mute, true); });
        window.gp.channels.on("event:unmute", function (mute) { muteEventHandler(mute, false); });

        return true;
    };

    window.__gpChatOnJoinedChannel = function (channelId) {
        // Flush delayed sends that waited for numeric channelId after leave/rejoin.
        try {
            var queue = window.__gpChatPendingQueue || [];
            window.__gpChatPendingQueue = [];
            for (var i = 0; i < queue.length; i++) {
                try { queue[i](); } catch (err) {}
            }
        } catch (e) {}
        if (typeof window.__gpChatFetchChannelHistory === "function")
            window.__gpChatFetchChannelHistory(channelId);
        if (typeof window.__gpChatStartLivePoll === "function")
            window.__gpChatStartLivePoll(channelId);
    };

    window.__gpChatFetchChannelHistory = async function (channelId) {
        try {
            if (!window.gp || !window.gp.channels || !window.gp.channels.fetchMessages)
                return;
            var r = await window.gp.channels.fetchMessages({
                channelId: channelId,
                limit: 40,
                offset: 0
            });
            var items = r && r.items ? r.items : [];
            for (var i = items.length - 1; i >= 0; i--)
                window.__gpChatDeliverHistoryMessage(items[i]);
        } catch (err) {
            console.warn("[GPChat] fetchMessages failed", err);
        }
    };

    window.__gpChatFetchRecentLive = async function (channelId) {
        try {
            if (!window.gp || !window.gp.channels || !window.gp.channels.fetchMessages)
                return;
            var r = await window.gp.channels.fetchMessages({
                channelId: channelId,
                limit: 20,
                offset: 0
            });
            var items = r && r.items ? r.items : [];
            for (var i = 0; i < items.length; i++)
                window.__gpChatDeliverMessage(items[i]);
        } catch (err) {
            console.warn("[GPChat] live poll failed", err);
        }
    };

    window.__gpChatRequestHistoryReload = async function () {
        try {
            var cid = window.__gpChatResolvedChannelId;
            if (cid == null || !window.gp || !window.gp.channels || !window.gp.channels.fetchMessages)
                return;
            var r = await window.gp.channels.fetchMessages({
                channelId: cid,
                limit: 40,
                offset: 0
            });
            var items = r && r.items ? r.items : [];
            for (var i = items.length - 1; i >= 0; i--)
                window.__gpChatDeliverHistoryMessage(items[i]);
        } catch (err) {
            console.warn("[GPChat] history reload failed", err);
        }
    };

    window.__gpChatStartLivePoll = function (channelId) {
        if (window.__gpChatLivePollTimer)
            clearInterval(window.__gpChatLivePollTimer);
        window.__gpChatLivePollChannelId = channelId;
        window.__gpChatLivePollTimer = setInterval(function () {
            var cid = window.__gpChatLivePollChannelId;
            if (cid != null && window.__gpChatFetchRecentLive)
                window.__gpChatFetchRecentLive(cid);
        }, 15000);
    };
})();
