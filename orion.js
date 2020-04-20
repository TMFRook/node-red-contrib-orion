#!/usr/bin/env node
/**
 * Orion Node-RED Nodes.
 *
 * Author:: Greg Albrecht <gba@orionlabs.io>
 * Copyright:: Copyright 2020 Orion Labs, Inc.
 * License:: Apache License, Version 2.0
 * Source:: https://github.com/orion-labs/node-red-contrib-orion
 */

'use strict';

const OrionClient = require('@orionlabs/node-orion');

module.exports = function (RED) {
  /**
   * Meta-Node for containing other Node-level configurations.
   * This node would not appear in a Pallet or within a Flow, and instead
   * is used by the OrionRXNode, OrionTXNode & OrionLookupNode to provide
   * credentials to the Orion service.
   * @param config {Object} Orion Configuration
   * @constructor
   */
  function OrionConfig(config) {
    RED.nodes.createNode(this, config);
    this.username = config.username;
    this.password = config.password;
    this.groupIds = config.groupIds;
  }
  RED.nodes.registerType('orion_config', OrionConfig, {
    credentials: { username: { type: 'text' }, password: { type: 'text' } },
  });

  /**
   * Node for Transmitting (TX) events to Orion.
   * @constructor
   * @param {config} config - FIXME
   */
  function OrionTXNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.orion_config = RED.nodes.getNode(config.orion_config);
    node.username = node.orion_config.credentials.username;
    node.password = node.orion_config.credentials.password;
    node.groupIds = node.orion_config.groupIds;

    node.status({ fill: 'yellow', shape: 'dot', text: 'Idle' });

    node.on('input', (msg) => {
      if (msg.event_type && msg.event_type === 'userstatus') {
        // Handle "userstatus" Event...
        OrionClient.auth(node.username, node.password).then((resolve) => {
          const token = resolve.token;
          OrionClient.updateUserStatus(token, msg)
            .then((resolve, reject) => {
              if (resolve) {
                node.status({
                  fill: 'green',
                  shape: 'dot',
                  text: 'Updated userstatus',
                });
                console.log(`${new Date().toISOString()} resolve=${resolve}`);
              } else if (reject) {
                console.error(`${new Date().toISOString()} reject=${reject}`);
              }
            })
            .catch((error) => {
              console.log(`${new Date().toISOString()} error=${error}`);
            });
        });
        node.status({ fill: 'yellow', shape: 'dot', text: 'Idle' });
      } else {
        // Handle "PTT" Event...
        node.status({ fill: 'green', shape: 'dot', text: 'Transmitting' });

        OrionClient.auth(node.username, node.password).then((resolve) => {
          const token = resolve.token;
          const userId = resolve.id;

          const target = msg.target_self ? userId : msg.target;

          const resolveGroups = (token) => {
            return new Promise((resolve) => {
              if (msg.groupids && typeof msg.groupIds === 'string' && msg.groupIds === 'ALL') {
                OrionClient.getAllUserGroups(token).then((resolve) => {
                  const _groups = [];
                  resolve.forEach((group) => _groups.push(group.id));
                  return _groups;
                });
              } else if (msg.groupIds && typeof msg.groupIds === 'string') {
                resolve(msg.groupIds.replace(/(\r\n|\n|\r)/gm, '').split(','));
              } else if (typeof node.groupIds === 'string' && node.groupids === 'ALL') {
                OrionClient.getAllUserGroups(token).then((resolve) => {
                  const _groups = [];
                  resolve.forEach((group) => _groups.push(group.id));
                  return _groups;
                });
              } else if (typeof node.groupIds === 'string') {
                resolve(node.groupIds.replace(/(\r\n|\n|\r)/gm, '').split(','));
              }
            });
          };

          resolveGroups(token).then((resolve) => {
            let groups = resolve;
            OrionClient.utils
              .lyre(token, groups, msg.message, msg.media, target)
              .then((resolve) => node.send(resolve));
          });
        });
      }

      node.status({ fill: 'yellow', shape: 'dot', text: 'Idle' });

      Promise.resolve().then(() => {
        if (msg.unitTest) {
          this.warn(msg.unitTest);
        }
      });
    });

    node.on('close', () => {});
  }
  RED.nodes.registerType('orion_tx', OrionTXNode, {
    credentials: { username: { type: 'text' }, password: { type: 'text' } },
  });

  /**
   * Node for Receiving (RX) events from Orion.
   * @param config {OrionConfig} Orion Config Meta-Node.
   * @constructor
   */
  function OrionRXNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    let ws;
    // FIXME: Use verbosity...
    // const verbosity = config.verbosity;
    const ignoreSelf = config.ignoreSelf;

    node.orion_config = RED.nodes.getNode(config.orion_config);
    node.username = node.orion_config.credentials.username;
    node.password = node.orion_config.credentials.password;

    node.status({ fill: 'red', shape: 'dot', text: 'Disconnected' });

    const resolveGroups = (token) => {
      return new Promise((resolve) => {
        if (node.orion_config.groupIds === 'ALL') {
          OrionClient.getAllUserGroups(token).then((resolve) => {
            const _groups = [];
            resolve.forEach((group) => _groups.push(group.id));
            return _groups;
          });
        } else {
          resolve(node.orion_config.groupIds.replace(/(\r\n|\n|\r)/gm, '').split(','));
        }
      });
    };

    OrionClient.auth(node.username, node.password).then((resolve) => {
      const token = resolve.token;
      const userId = resolve.id;

      resolveGroups(token).then((resolve) => {
        const groups = resolve;
        OrionClient.engage(token, groups).then(() => {
          OrionClient.connectToWebsocket(token).then((websocket) => {
            ws = websocket;
            node.status({ fill: 'yellow', shape: 'dot', text: 'Connected & Idle' });

            websocket.onmessage = (data) => {
              const eventData = JSON.parse(data.data);

              /* console.debug(
                  `${new Date().toISOString()} ` +
                  `ws.onmessage ` +
                  `eventData.event_type=${eventData.event_type} ` +
                  `event_data.eventId=${eventData.eventId}`,
              ); */

              switch (eventData.event_type) {
                case 'ptt':
                  // Handle PTT Events
                  /*
                  If 'ignoreSelf' is False: Send PTTs (target and group).
                  if 'ignoreSelf' is True: Send PTTs (target and group) as
                    long as they ARE NOT from me! (Stop hitting yourself!)
                  */
                  if (!ignoreSelf || userId !== eventData.sender) {
                    node.send([
                      eventData, // Output 0 (all)
                      eventData, // Output 1 (ptt)
                      null, // Output 2 (userstatus)
                      // 'target_user_id' is only set on direct/target messages
                      // Output 3 (direct/target)
                      eventData.target_user_id ? eventData : null,
                    ]);
                  }
                  break;
                case 'userstatus':
                  // Handle Userstatus Events
                  if (!ignoreSelf || userId !== eventData.id) {
                    node.send([eventData, null, eventData, null]);
                  }
                  break;
                case 'ping':
                  // Handle Ping Events
                  OrionClient.pong(token)
                    .then(() => {
                      node.status({ fill: 'green', shape: 'dot', text: 'Engaged' });
                    })
                    .catch(() => {
                      node.status({
                        fill: 'yellow',
                        shape: 'dot',
                        text: 'Re-engaging',
                      });
                      OrionClient.engage(token, groups)
                        .then(() => {
                          node.status({
                            fill: 'green',
                            shape: 'dot',
                            text: 'Engaged',
                          });
                        })
                        .catch(() => {
                          new Error('Unable to re-engage');
                        });
                    });
                  break;
                default:
                  // Handle undefined Events
                  node.send([eventData, null, null, null]);
                  break;
              }
              node.status({ fill: 'yellow', shape: 'dot', text: 'Connected & Idle' });
            };

            websocket.onclose = (event) => {
              console.warn(
                `${new Date().toISOString()} ${node.id} ` + `websocket.onclose err=${event.code}`,
              );
              if (event.code !== 4158) {
                console.warn(`${new Date().toISOString()} ${node.id} Closing.`);
                websocket = null;
                ws = null;
              }
            };
          });
        });
      });
    });

    node.on('close', () => {
      node.debug(`${node.id} Closing OrionRX.`);
      try {
        ws.close(4158);
      } catch (err) {
        console.error(`${new Date().toISOString()} ${node.id} Caught err=${err}`);
      }
      node.status({ fill: 'red', shape: 'dot', text: 'Disconnected' });
    });
  }
  RED.nodes.registerType('orion_rx', OrionRXNode, {
    credentials: {
      username: { type: 'text' },
      password: { type: 'text' },
      groupIds: { type: 'text' },
    },
  });

  /**
   * Node for encoding PCM/WAV to Orion Opus.
   * @param config
   * @constructor
   */
  function OrionEncode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.status({ fill: 'yellow', shape: 'dot', text: 'Idle' });

    node.on('input', (msg) => {
      if (msg.payload) {
        node.status({ fill: 'green', shape: 'dot', text: 'Encoding' });
        OrionClient.utils.wav2ov(msg).then((resolve) => {
          node.send(resolve);
        });
        node.status({ fill: 'yellow', shape: 'dot', text: 'Idle' });
      } else {
        node.send(msg);
      }
    });
  }
  RED.nodes.registerType('orion_encode', OrionEncode);

  /**
   * Node for transcribing Orion Audio to Text.
   * @param config
   * @constructor
   */
  function OrionTranscribe(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.status({ fill: 'yellow', shape: 'dot', text: 'Idle' });

    node.on('input', (msg) => {
      if (msg.media) {
        node.status({ fill: 'green', shape: 'dot', text: 'Encoding' });
        OrionClient.utils.stt(msg).then((resolve) => {
          node.send(resolve);
        });
        node.status({ fill: 'yellow', shape: 'dot', text: 'Idle' });
      } else {
        node.send(msg);
      }
    });
  }
  RED.nodes.registerType('orion_transcribe', OrionTranscribe);

  /**
   * Node for translating Orion Audio events between languages.
   * @param config {OrionConfig}
   * @constructor
   */
  function OrionTranslate(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.status({ fill: 'yellow', shape: 'dot', text: 'Idle' });

    node.on('input', (msg) => {
      if (msg.media) {
        node.status({ fill: 'green', shape: 'dot', text: 'Translating' });
        msg.input_lang = config.inputlanguageCode;
        msg.output_lang = config.outputlanguageCode;
        OrionClient.utils.translate(msg, (response) => node.send(response));
        node.status({ fill: 'yellow', shape: 'dot', text: 'Idle' });
      } else {
        node.send(msg);
      }
    });
  }
  RED.nodes.registerType('orion_translate', OrionTranslate);

  /**
   * Decode Orion Opus files to WAV/PCM.
   * @param config
   * @constructor
   */
  function OrionDecode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.status({ fill: 'yellow', shape: 'dot', text: 'Idle' });

    node.on('input', (msg) => {
      if (msg.event_type && msg.event_type === 'ptt') {
        node.status({ fill: 'green', shape: 'dot', text: 'Decoding' });
        msg.return_type = config.return_type;
        OrionClient.utils.ov2wav(msg).then((response) => node.send(response));
        node.status({ fill: 'yellow', shape: 'dot', text: 'Idle' });
      } else {
        node.send(msg);
      }
    });
  }
  RED.nodes.registerType('orion_decode', OrionDecode);

  /**
   * Node for looking-up Orion User & Group Profiles.
   * @param config {OrionConfig}
   * @constructor
   */
  function OrionLookup(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.orion_config = RED.nodes.getNode(config.orion_config);

    node.username = node.orion_config.credentials.username;
    node.password = node.orion_config.credentials.password;

    node.status({ fill: 'yellow', shape: 'dot', text: 'Idle' });

    node.on('input', (msg) => {
      OrionClient.auth(node.username, node.password).then((resolve) => {
        const token = resolve.token;
        node.status({ fill: 'blue', shape: 'dot', text: 'Lookup' });

        if (msg.payload && msg.payload === 'whoami') {
          OrionClient.whoami(token).then((resolve) => {
            msg.user_info = resolve;
            const userId = resolve.id;
            OrionClient.getUserStatus(token, userId).then((resolve) => {
              msg.userstatus_info = resolve;
              node.send(msg);
            });
          });
        } else if (msg.event_type && msg.event_type === 'userstatus') {
          const userId = msg.id;
          OrionClient.getUser(token, userId).then((resolve) => {
            msg.user_info = resolve;
            OrionClient.getUserStatus(token, userId).then((resolve) => {
              msg.userstatus_info = resolve;
              node.send(msg);
            });
          });
        } else if (msg.event_type && msg.event_type === 'ptt') {
          const groupId = msg.id;
          const userId = msg.sender;
          OrionClient.getGroup(token, groupId).then((resolve) => {
            msg.group_info = resolve;
            OrionClient.getUser(token, userId).then((resolve) => {
              msg.user_info = resolve;
              OrionClient.getUserStatus(token, userId).then((resolve) => {
                msg.userstatus_info = resolve;
                node.send(msg);
              });
            });
          });
        } else if (msg.group) {
          const groupId = msg.group;
          OrionClient.getGroup(token, groupId).then((resolve) => {
            msg.group_info = resolve;
            node.send(msg);
          });
        } else if (msg.user) {
          const userId = msg.user;
          OrionClient.getUser(token, userId).then((resolve) => {
            msg.user_info = resolve;
            OrionClient.getUserStatus(token, userId).then((resolve) => {
              msg.userstatus_info = resolve;
              node.send(msg);
            });
          });
        }
        node.status({ fill: 'yellow', shape: 'dot', text: 'Idle' });
      });
    });

    node.on('close', () => {});
  }
  RED.nodes.registerType('orion_lookup', OrionLookup, {
    credentials: { username: { type: 'text' }, password: { type: 'text' } },
  });
};
