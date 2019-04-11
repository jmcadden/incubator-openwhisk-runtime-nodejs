/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var NodeActionRunner = require('../runner');
var fs = require('fs');
// var take_snapshot = true;

function NodeActionService(config) {
    var Status = {
        ready: 'ready',
        starting: 'starting',
        running: 'running',
        stopped: 'stopped'
    };

    var status = Status.ready;
    var server = undefined;
    var userCodeRunner = undefined;

    function setStatus(newStatus) {
        if (status !== Status.stopped) {
            status = newStatus;
        }
    }

    /**
     * An ad-hoc format for the endpoints returning a Promise representing,
     * eventually, an HTTP response.
     *
     * The promised values (whether successful or not) have the form:
     * { code: int, response: object }
     *
     */
    function responseMessage (code, response) {
        return { code: code, response: response };
    }

    function errorMessage (code, errorMsg) {
        return responseMessage(code, { error: errorMsg });
    }

    /**
     * Starts the server.
     *
     * @param app express app
     */
    this.start = function start(app) {
        var self = this;
        server = app.listen(app.get('port'), function() {
            var host = server.address().address;
            var port = server.address().port;
            /** TODO: Warm SNAPSHOT possibility here. */
            var os    = require('os');
            os.uptime();
        });
        //This is required as http server will auto disconnect in 2 minutes, this to not auto disconnect at all
        server.timeout = 0;
    };

    /** Returns a promise of a response to the /init invocation.
     *
     *  req.body = { main: String, code: String, binary: Boolean }
     */
    this.initCode = function initCode(req) {
        // XXX: made change here, might not be safe.
        // if (status === Status.ready && userCodeRunner === undefined) {
        if (status === Status.ready ) {
            setStatus(Status.starting);

            var body = req.body || {};
            var message = body.value || {};

            if (message.main && message.code && typeof message.main === 'string' && typeof message.code === 'string') {
                return doInit(message).then(function (result) {
                    setStatus(Status.ready);

                    /** TODO: Orig Hot SNAPSHOT point. */
                    var os    = require('os');
                    os.uptime();

                    return responseMessage(200, { OK: true });
                }).catch(function (error) {
                    var errStr = error.stack ? String(error.stack) : error;
                    setStatus(Status.stopped);
                    return Promise.reject(errorMessage(502, "Initialization has failed due to: " + errStr));
                });
            } else {
                setStatus(Status.ready);
                return Promise.reject(errorMessage(403, "Missing main/no code to execute."));
            }
        } else if (userCodeRunner !== undefined) {
            var msg = "Cannot initialize the action more than once.";
            console.error("Internal system error:", msg);
            return Promise.reject(errorMessage(403, msg));
        } else {
            var msg = "System not ready, status is " + status + ".";
            console.error("Internal system error:", msg);
            return Promise.reject(errorMessage(403, msg));
        }
    };

    this.preInitCode = function preInitCode(req) {
        console.log("tu nop");
        // Init some code.

        if (status === Status.ready && userCodeRunner === undefined) {
            setStatus(Status.starting);
            var body = req.body || {};
            var message = body.value || {};
        } else {
            console.log("crap, we\'re not ready");
            console.log("or userCodeRunner is defined");
            process.exit(13);
        };

        return doInit(message).then(function (result) {
            setStatus(Status.ready);
            return responseMessage(200, { OK: true });
        });
    };

    this.preRunCode = function preRunCode(req){
        // Init is done, do run.
        if (status === Status.ready) {
            setStatus(Status.running);
        } else {
            console.log("shit, we\'re not ready");
            process.exit(13);
        }

        return doRun(req).then(function (result) {
            setStatus(Status.ready);
            var os    = require('os');
            os.uptime();
            return responseMessage(200, result);
        });
    };

    /**
     * Returns a promise of a response to the /exec invocation.
     * Note that the promise is failed if and only if there was an unhandled error
     * (the user code threw an exception, or our proxy had an internal error).
     * Actions returning { error: ... } are modeled as a Promise successful resolution.
     *
     * req.body = { value: Object, meta { activationId : int } }
     */
    this.runCode = function runCode(req) {
        if (status === Status.ready) {
            setStatus(Status.running);

            return doRun(req).then(function (result) {
                setStatus(Status.ready);

                // NOTE: Hot snapshot bloating hot snapshot point here.
                // if(take_snapshot == true){
                //     take_snapshot = false;
                //     /** HOT SNAPSHOT */
                //     var os = require('os');
                //     os.uptime();
                // }

                if (typeof result !== "object") {
                    return errorMessage(502, "The action did not return a dictionary.");
                } else {
                    return responseMessage(200, result);
                }
            }).catch(function (error) {
                setStatus(Status.stopped);
                return Promise.reject(errorMessage(502, "An error has occurred: " + error));
            });
        } else {
            var msg = "System not ready, status is " + status + ".";
            console.error("Internal system error:", msg);
            return Promise.reject(errorMessage(403, msg));
        }
    };

    function doInit(message) {
        userCodeRunner = new NodeActionRunner();

        return userCodeRunner.init(message).then(function (result) {
            // 'true' has no particular meaning here. The fact that the promise
            // is resolved successfully in itself carries the intended message
            // that initialization succeeded.
            return true;
        }).catch(function (error) {
            // emit error to activation log then flush the logs as this
            // is the end of the activation
            console.error('Error during initialization:', error);
            writeMarkers();
            return Promise.reject(error);
        });
    }

    function doRun(req) {
        var msg = req.body || {};

        var props = [ 'api_key', 'namespace', 'action_name', 'activation_id', 'deadline' ];
        props.map(function (p) {
            process.env['__OW_' + p.toUpperCase()] = msg[p];
        });

        return userCodeRunner.run(msg.value).then(function(result) {
            if (typeof result !== "object") {
                console.error('Result must be of type object but has type "' + typeof result + '":', result);
            }
            writeMarkers();
            return result;
        }).catch(function (error) {
            console.error(error);
            writeMarkers();
            return Promise.reject(error);
        });
    }

    function writeMarkers() {
        // console.log('XXX_THE_END_OF_A_WHISK_ACTIVATION_XXX');
        // console.error('XXX_THE_END_OF_A_WHISK_ACTIVATION_XXX');
    }
}

NodeActionService.getService = function(config) {
    return new NodeActionService(config);
};

module.exports = NodeActionService;
