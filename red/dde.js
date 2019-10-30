//@ts-check
/*
  Copyright: (c) 2019, Guilherme Francescon Cittolin <gfcittolin@gmail.com>
  GNU General Public License v3.0+ (see LICENSE or https://www.gnu.org/licenses/gpl-3.0.txt)
*/

/**
 * Compares values for equality, includes special handling for arrays. Fixes #33
 * @param {number|string|Array} a
 * @param {number|string|Array} b 
 */
function equals(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length != b.length) return false;

        for (var i = 0; i < a.length; ++i) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }
    return false;
}

var MIN_CYCLE_TIME = 50;

module.exports = function (RED) {
    "use strict";

    var util = require('util');
    var netdde = require('netdde');
    var EventEmitter = require('events').EventEmitter;

    // ---------- DDE Endpoint ----------

    function generateStatus(status, val) {
        var obj;

        if (typeof val != 'string' && typeof val != 'number' && typeof val != 'boolean') {
            val = RED._("dde.status.online");
        }

        switch (status) {
            case 'online':
                obj = {
                    fill: 'green',
                    shape: 'dot',
                    text: val.toString()
                };
                break;
            case 'badvalues':
                obj = {
                    fill: 'yellow',
                    shape: 'dot',
                    text: RED._("dde.status.badvalues")
                };
                break;
            case 'offline':
                obj = {
                    fill: 'red',
                    shape: 'dot',
                    text: RED._("dde.status.offline")
                };
                break;
            case 'connecting':
                obj = {
                    fill: 'yellow',
                    shape: 'dot',
                    text: RED._("dde.status.connecting")
                };
                break;
            default:
                obj = {
                    fill: 'grey',
                    shape: 'dot',
                    text: RED._("dde.status.unknown")
                };
        }
        return obj;
    }

    function DDEEndpoint(config) {
        EventEmitter.call(this);
        var node = this;
        var status;
        var closing = false;
        var connectTimeoutTimer;
        var topicsTimeoutTimer;
        var service = config.service;
        var trackAdvise = config.trackadvise;
        var advises = new Map();
        var offlineTopics = new Set();

        if (!service) {
            node.error(RED._('dde.error.noservice'));
            return;
        }

        RED.nodes.createNode(this, config);
        this.setMaxListeners(0); //avoids warnings when we have a lot of connected nodes

        var connOpts = {
            host: config.address,
            port: config.port,
            timeout: config.timeout,
            process: "Node-RED"
        }
        var conn = new netdde.NetDDEClient(service, connOpts);
        conn.on('error', onError);
        conn.on('close', reconnect);
        conn.on('advise', onAdvise);
        conn.on('topic_disconnect', onTopicDisconnect);

        node.getStatus = function getStatus() {
            return status;
        };

        node.doRequest = function doRequest(topic, item, format) {
            return conn.request(topic, item, format);
        }

        node.doPoke = function doRequest(topic, item, format, data) {
            return conn.poke(topic, item, format, data);
        }

        node.doExecute = function doExecute(topic, command) {
            return conn.execute(topic, command);
        }

        node.doAdvise = function doAdvise(topic, item, format) {
            let reqVal = false; //maybe add a config for that
            return conn.advise(topic, item, format, reqVal).then(() => {
                // put item in the track map _after_ result, so we add only if advise was OK
                if (trackAdvise) {
                    advises.set(`${topic}!${item}!${format}`, {
                        topic, item, format, reqVal
                    });
                }
            });
        }

        node.doAdviseStop = function doAdviseStop(topic, item, format) {
            if (trackAdvise) {
                advises.delete(`${topic}!${item}!${format}`);
            }

            return conn.stopAdvise(topic, item, format);
        }

        node.doAdviseStopAll = function doAdviseStopAll() {
            let res = []
            for (const elm of advises.values()) {
                res.push(conn.stopAdvise(elm.topic, elm.item, elm.format));
            }
            advises.clear();
            offlineTopics.clear();

            return Promise.all(res);
        }

        /**
         * Requests all advises once again after a connection drop
         */
        function readvise(topic) {
            for (const elm of advises.values()) {

                if (topic && elm.topic != topic) continue;

                conn.advise(elm.topic, elm.item, elm.format, elm.reqVal).catch(e => {
                    node.error(RED._('dde.error.onreadvise', { err: e.toString() }));
                });
            }
        }

        function manageStatus(newStatus) {
            if (status == newStatus) return;

            status = newStatus;
            node.emit('__STATUS__', {
                status: status
            });
        }

        function onAdvise(d) {
            node.emit('advise', d);
        }

        function checkOfflineTopics() {
            for (const topic of offlineTopics.keys()) {

                //tries to check if topic is back by
                //creating the conversation again
                conn._getConversation(topic).then(() => {
                    // topic is there, call advise again
                    offlineTopics.delete(topic);
                    readvise(topic);
                }).catch(e => {
                    onTopicDisconnect(topic);
                })
            }
        }

        function onTopicDisconnect(topic) {
            node.emit('topic_disconnect', topic);

            if (trackAdvise) {
                offlineTopics.add(topic);
                clearTimeout(topicsTimeoutTimer);
                topicsTimeoutTimer = setTimeout(checkOfflineTopics, 5000);
            }
        }

        function onConnect() {
            clearTimeout(connectTimeoutTimer);
            manageStatus('online');

            readvise();
        }

        function onConnectError(err){
            node.error(RED._("dde.error.onconnect", { err: err.toString() }), {});
            reconnect();
        }

        function onError(err){
            node.error(err && err.toString(), {});
            //reconnect(); // #close will get also emitted, so we reconnect from there
        }

        function reconnect() {
            clearTimeout(topicsTimeoutTimer);
            clearTimeout(connectTimeoutTimer);

            if (closing) return;

            closeConnection(() => {
                //try to reconnect if failed to connect
                connectTimeoutTimer = setTimeout(connect, 5000);
            });
        }

        function closeConnection(done) {
            //ensure we won't try to connect again if anybody wants to close it
            clearTimeout(connectTimeoutTimer);
            clearTimeout(topicsTimeoutTimer);

            manageStatus('offline');
            conn.disconnect().catch(function (e) {
                node.error(RED._('dde.error.ondisconnect', { err: e.toString() }));
            }).then(done);
        }

        function onClose(done) {
            closing = true;
            closeConnection(done);
        }
        node.on('close', onClose);

        function connect() {
            manageStatus('connecting');
            conn.connect().then(onConnect).catch(onConnectError);
        }

        connect();

    }
    RED.nodes.registerType("dde endpoint", DDEEndpoint);

    // ---------- DDE ----------

    function DDE(config) {
        var node = this;
        var statusVal;
        RED.nodes.createNode(this, config);

        var endpoint = RED.nodes.getNode(config.endpoint);
        if (!endpoint) {
            return node.error(RED._("dde.error.missingconfig"));
        }

        function onEndpointStatus(s) {
            node.status(generateStatus(s.status, statusVal));
        }

        function doRequest(msg) {
            let topic = config.topic || msg.topic;
            let item = config.item || msg.item;
            let format = netdde.Constants.dataType[config.format || msg.format];

            if (!Array.isArray(item)) {
                item = [item];
            }

            let res = [];
            for (const it of item) {
                res.push(endpoint.doRequest(topic, it, format));
            }

            Promise.all(res).then(d => {
                if (d.length == 1) {
                    d = d[0];
                }
                msg.payload = d;
                node.send(msg);
            }).catch(e => {
                node.error(e, msg);
            });
        }

        function doPoke(msg) {
            let topic = config.topic || msg.topic;
            let item = config.item || msg.item;
            let format = netdde.Constants.dataType[config.format || msg.format];
            let data = msg.payload;

            if (!Array.isArray(item)) {
                item = [item];
            }

            let res = [];
            for (const it of item) {
                res.push(endpoint.doPoke(topic, it, format, data));
            }

            Promise.all(res).then(d => {
                node.send(msg);
            }).catch(e => {
                node.error(e, msg);
            });
        }

        function doExecute(msg) {
            let topic = config.topic || msg.topic;
            let command = config.command || msg.payload;

            if (!Array.isArray(command)) {
                command = [command];
            }

            let res = [];
            for (const it of command) {
                res.push(endpoint.doExecute(topic, it));
            }

            Promise.all(res).then(d => {
                node.send(msg);
            }).catch(e => {
                node.error(e, msg);
            }); 
        }

        function doAdvise(msg) {
            let topic = config.topic || msg.topic;
            let item = config.item || msg.item;
            let format = netdde.Constants.dataType[config.format || msg.format];

            if (!Array.isArray(item)) {
                item = [item];
            }

            let res = [];
            for (const it of item) {
                res.push(endpoint.doAdvise(topic, it, format));
            }

            Promise.all(res).then(d => {
                node.send(msg);
            }).catch(e => {
                node.error(e, msg);
            });
        }

        function doAdviseStop(msg) {
            let topic = config.topic || msg.topic;
            let item = config.item || msg.item;
            let format = netdde.Constants.dataType[config.format || msg.format];

            if (!Array.isArray(item)) {
                item = [item];
            }

            let res = [];
            for (const it of item) {
                res.push(endpoint.doAdviseStop(topic, it, format));
            }

            Promise.all(res).then(d => {
                node.send(msg);
            }).catch(e => {
                node.error(e, msg);
            });
        }

        function doAdviseStopAll(msg) {
            endpoint.doAdviseStopAll().then(d => {
                node.send(msg);
            }).catch(e => {
                node.error(e, msg);
            });
        }

        function onAdvise(d) {
            node.send([
                null,
                {
                    payload: d.data,
                    topic: d.topic,
                    item: d.item,
                    format: d.format
                }
            ]);
        }

        node.status(generateStatus(endpoint.getStatus(), statusVal));

        switch (config.function) {
            case 'advise': 
                node.on('input', doAdvise);
                endpoint.on('advise', onAdvise);
                break;
            case 'request': node.on('input', doRequest); break;
            case 'poke': node.on('input', doPoke); break;
            case 'execute': node.on('input', doExecute); break;
            case 'advise-stop': node.on('input', doAdviseStop); break;
            case 'advise-stop-all': node.on('input', doAdviseStopAll); break;
            default:
                node.error(RED._("dde.error.invalidcontrolfunction", { function: config.function }));
        }

        endpoint.on('__STATUS__', onEndpointStatus);

        node.on('close', function (done) {
            endpoint.removeListener('__STATUS__', onEndpointStatus);
            endpoint.removeListener('advise', onAdvise);
            done();
        });

    }
    RED.nodes.registerType("dde", DDE);
};
