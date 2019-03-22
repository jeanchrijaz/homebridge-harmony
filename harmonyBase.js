var Service, Characteristic;
const HarmonyConst = require('./harmonyConst');

const Harmony = require('harmony-websocket');
const HarmonyTools = require('./harmonyTools.js');

module.exports = {
  HarmonyBase: HarmonyBase,
};

function HarmonyBase(api) {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  this.harmony = new Harmony();
  this.numberAttemps = 0;
}

HarmonyBase.prototype = {
  configCommonProperties: function(log, config, api, harmonyPlatform) {
    harmonyPlatform.log = log;
    harmonyPlatform.hubIP = config['hubIP'];

    harmonyPlatform.name = config['name'];
    harmonyPlatform.devMode = config['DEVMODE'];

    harmonyPlatform.addAllActivitiesToSkipedIfSameStateActivitiesList =
      config['addAllActivitiesToSkipedIfSameStateActivitiesList'];
    harmonyPlatform.skipedIfSameStateActivities =
      config['skipedIfSameStateActivities'];

    harmonyPlatform.devicesToPublishAsAccessoriesSwitch =
      config['devicesToPublishAsAccessoriesSwitch'];
    harmonyPlatform.publishDevicesAsIndividualAccessories = HarmonyTools.checkParameter(
      config['publishDevicesAsIndividualAccessories'],
      true
    );

    harmonyPlatform.sequencesToPublishAsAccessoriesSwitch =
      config['sequencesToPublishAsAccessoriesSwitch'];

    harmonyPlatform.publishSequencesAsIndividualAccessories = HarmonyTools.checkParameter(
      config['publishSequencesAsIndividualAccessories'],
      true
    );

    harmonyPlatform.publishHomeControlButtons =
      config['publishHomeControlButtons'];

    harmonyPlatform.publishHomeControlsAsIndividualAccessories = HarmonyTools.checkParameter(
      config['publishHomeControlsAsIndividualAccessories'],
      true
    );

    harmonyPlatform._currentActivity = -9999;
    harmonyPlatform._currentActivityLastUpdate = undefined;
    harmonyPlatform._currentSetAttemps = 0;
    harmonyPlatform._foundAccessories = [];

    harmonyPlatform.log.debug(
      'INFO : following activites controls will be ignored if they are in the same state : ' +
        (harmonyPlatform.addAllActivitiesToSkipedIfSameStateActivitiesList
          ? 'ALL'
          : harmonyPlatform.skipedIfSameStateActivities)
    );

    if (api) {
      // Save the API object as plugin needs to register new accessory via this object
      harmonyPlatform.api = api;
      harmonyPlatform.api.on(
        'shutdown',
        function() {
          harmonyPlatform.log('INFO - shutdown');
          this.harmony.removeAllListeners();
          this.harmony.end();
        }.bind(this)
      );
    }
  },

  getInformationService: function(homebridgeAccessory) {
    let informationService = new Service.AccessoryInformation();
    informationService
      .setCharacteristic(Characteristic.Name, homebridgeAccessory.name)
      .setCharacteristic(
        Characteristic.Manufacturer,
        homebridgeAccessory.manufacturer
      )
      .setCharacteristic(Characteristic.Model, homebridgeAccessory.model)
      .setCharacteristic(
        Characteristic.SerialNumber,
        homebridgeAccessory.serialNumber
      );
    return informationService;
  },

  getServices: function(homebridgeAccessory) {
    let services = [];
    let informationService = this.getInformationService(homebridgeAccessory);
    services.push(informationService);
    for (let s = 0; s < homebridgeAccessory.services.length; s++) {
      let service = homebridgeAccessory.services[s];
      for (let i = 0; i < service.characteristics.length; i++) {
        let characteristic = service.controlService.getCharacteristic(
          service.characteristics[i]
        );
        if (characteristic == undefined)
          characteristic = service.controlService.addCharacteristic(
            service.characteristics[i]
          );
        homebridgeAccessory.platform.bindCharacteristicEvents(
          characteristic,
          service,
          homebridgeAccessory
        );
      }
      services.push(service.controlService);
    }
    return services;
  },

  handleCharacteristicUpdate: function(
    harmonyPlatform,
    characteristic,
    value,
    callback
  ) {
    if (
      harmonyPlatform._currentActivity ==
      HarmonyConst.CURRENT_ACTIVITY_NOT_SET_VALUE
    ) {
      this.updateCharacteristicToErr(characteristic, callback);
    } else {
      this.updateCharacteristic(characteristic, value, callback);
    }
  },

  updateCharacteristicToErr: function(characteristic, callback) {
    try {
      if (callback) {
        callback(1);
      } else {
        characteristic.updateValue(undefined);
      }
    } catch (error) {
      characteristic.updateValue(undefined);
    }
  },

  updateCharacteristic: function(
    characteristic,
    characteristicValue,
    callback
  ) {
    try {
      if (callback) {
        callback(undefined, characteristicValue);
      } else {
        characteristic.updateValue(characteristicValue);
      }
    } catch (error) {
      characteristic.updateValue(characteristicValue);
    }
  },

  configureAccessories: function(harmonyPlatform, callback) {
    harmonyPlatform.log('INFO - Loading activities...');

    this.harmony.removeAllListeners();

    this.harmony.on('open', () => {
      harmonyPlatform.log.debug('INFO - socket opened');
    });

    this.harmony.on('close', () => {
      harmonyPlatform.log.debug('WARNING - socket closed');
      var that = this;
      setTimeout(function() {
        that.refreshCurrentActivity(harmonyPlatform, () => {});
      }, HarmonyConst.DELAY_BEFORE_RECONNECT);
    });

    this.harmony.on('stateDigest', message => {
      harmonyPlatform.log.debug(
        'INFO - onMessage : received message : ' + JSON.stringify(message)
      );
      if (
        message.type === 'connect.stateDigest?get' ||
        (message.type === 'connect.stateDigest?notify' &&
          message.data.activityStatus === 2 &&
          message.data.activityId === message.data.runningActivityList) ||
        (message.type === 'connect.stateDigest?notify' &&
          message.data.activityStatus === 0 &&
          message.data.activityId === '-1' &&
          message.data.runningActivityList === '')
      ) {
        harmonyPlatform.log(
          'INFO - onMessage : Refreshing activity to ' + message.data.activityId
        );
        harmonyPlatform.onMessage(message.data.activityId);
      }
    });

    this.harmony
      .connect(
        harmonyPlatform.hubIP,
        HarmonyConst.HUB_CONNECT_TIMEOUT,
        HarmonyConst.HUB_SEND_TIMEOUT
      )
      .then(() => this.harmony.getConfig())
      .then(response => {
        harmonyPlatform.log.debug(
          'INFO - Hub config : ' + JSON.stringify(response)
        );
        harmonyPlatform.readAccessories(response, callback);
        this.numberAttemps = 0;
      })
      .catch(e => {
        var that = this;
        this.numberAttemps = this.numberAttemps + 1;

        harmonyPlatform.log(
          'Error - Error retrieving info from hub : ' +
            e.message +
            '-(' +
            this.numberAttemps +
            '/3)'
        );

        if (this.numberAttemps > 3) {
          throw 'Error - Harmony HUB at ' +
            harmonyPlatform.hubIP +
            " is not available - can't start plugin";
        } else {
          setTimeout(function() {
            that.configureAccessories(harmonyPlatform, callback);
          }, HarmonyConst.DELAY_BEFORE_RECONNECT);
        }
      });
  },

  refreshCurrentActivity: function(harmonyPlatform, callback) {
    if (
      harmonyPlatform._currentActivity >
        HarmonyConst.CURRENT_ACTIVITY_NOT_SET_VALUE &&
      harmonyPlatform._currentActivityLastUpdate &&
      Date.now() - harmonyPlatform._currentActivityLastUpdate <
        HarmonyConst.TIMEOUT_REFRESH_CURRENT_ACTIVITY
    ) {
      // we don't refresh since status was retrieved not so far away
      harmonyPlatform.log.debug(
        'INFO - refreshCurrentActivity : NO refresh needed since last update was on :' +
          harmonyPlatform._currentActivity +
          ' and current Activity is set'
      );
      callback();
    } else {
      harmonyPlatform.log.debug(
        'INFO - refreshCurrentActivity : Refresh needed since last update is too old or current Activity is not set : ' +
          harmonyPlatform._currentActivity
      );

      //if we dont have an activity set, we callback immediately
      var callbackDone = false;
      if (harmonyPlatform._currentActivity == CURRENT_ACTIVITY_NOT_SET_VALUE) {
        callback();
        callbackDone = true;
      }

      this.harmony
        .getCurrentActivity()
        .then(response => {
          harmonyPlatform.refreshCurrentActivity(response);
          if (!callbackDone) callback();
        })
        .catch(e => {
          harmonyPlatform.log('ERROR - refreshCurrentActivity ' + e);
          harmonyPlatform.refreshCurrentActivity(
            HarmonyConst.CURRENT_ACTIVITY_NOT_SET_VALUE
          );
          if (!callbackDone) callback();
        });
    }
  },

  getSequencesAccessories: function(harmonyPlatform, data) {
    if (
      harmonyPlatform.sequencesToPublishAsAccessoriesSwitch &&
      harmonyPlatform.sequencesToPublishAsAccessoriesSwitch.length > 0
    ) {
      harmonyPlatform.log('INFO - Loading sequences...');
      let sequences = data.data.sequence;
      let services = [];
      for (
        let c = 0,
          len = harmonyPlatform.sequencesToPublishAsAccessoriesSwitch.length;
        c < len;
        c++
      ) {
        var sequence = harmonyPlatform.sequencesToPublishAsAccessoriesSwitch[c];

        for (let i = 0, len = sequences.length; i < len; i++) {
          if (sequences[i].name === sequence) {
            let accessoryName = harmonyPlatform.name + '-' + sequence;
            let switchName = sequence;

            if (harmonyPlatform.devMode) {
              switchName = 'DEV' + switchName;
            }

            harmonyPlatform.log('INFO - Discovered sequence : ' + switchName);

            let service = {
              controlService: new Service.Switch(switchName),
              characteristics: [Characteristic.On],
            };
            service.controlService.subtype = switchName + '-' + sequence;
            service.controlService.id = sequences[i].id;
            service.type = HarmonyConst.SEQUENCE_TYPE;
            services.push(service);

            if (harmonyPlatform.publishSequencesAsIndividualAccessories) {
              harmonyPlatform.log('INFO - Adding Accessory : ' + accessoryName);
              let myHarmonyAccessory = new HarmonyTools.HarmonyAccessory(
                services
              );
              myHarmonyAccessory.getServices = function() {
                return harmonyPlatform.getServices(myHarmonyAccessory);
              };
              myHarmonyAccessory.platform = harmonyPlatform;
              myHarmonyAccessory.name = accessoryName;
              myHarmonyAccessory.model = harmonyPlatform.name;
              myHarmonyAccessory.manufacturer = 'Harmony';
              myHarmonyAccessory.serialNumber = harmonyPlatform.hubIP;
              harmonyPlatform._foundAccessories.push(myHarmonyAccessory);
              services = [];
            }
          }
        }
      }

      if (
        !harmonyPlatform.publishSequencesAsIndividualAccessories &&
        services.length > 0
      ) {
        harmonyPlatform.log(
          'INFO - Adding Accessory : ' + harmonyPlatform.name + '-Sequences'
        );
        let myHarmonyAccessory = new HarmonyTools.HarmonyAccessory(services);
        myHarmonyAccessory.getServices = function() {
          return harmonyPlatform.getServices(myHarmonyAccessory);
        };
        myHarmonyAccessory.platform = harmonyPlatform;
        myHarmonyAccessory.name = harmonyPlatform.name + '-Sequences';
        myHarmonyAccessory.model = harmonyPlatform.name;
        myHarmonyAccessory.manufacturer = 'Harmony';
        myHarmonyAccessory.serialNumber = harmonyPlatform.hubIP;
        harmonyPlatform._foundAccessories.push(myHarmonyAccessory);
      }
    }
  },

  printAndStoreCommands: function(harmonyPlatform, devices) {
    this.deviceCommands = {};
    for (let i = 0, len = devices.length; i < len; i++) {
      let controlGroup = devices[i].controlGroup;
      for (let j = 0, len = controlGroup.length; j < len; j++) {
        let functions = controlGroup[j].function;
        for (let k = 0, len = functions.length; k < len; k++) {
          harmonyPlatform.log(
            'INFO - Command : ' +
              functions[k].name +
              ' discovered for device : ' +
              devices[i].label
          );
          //Store command
          this.deviceCommands[[devices[i].label, functions[k].name]] =
            functions[k].action;
        }
      }
    }
  },

  populateCommands: function(harmonyPlatform, controlGroup, switchName) {
    let commandFunctions = [];

    for (let j = 0, len = controlGroup.length; j < len; j++) {
      if (controlGroup[j].name === 'Power') {
        let functions = controlGroup[j].function;
        for (let k = 0, len = functions.length; k < len; k++) {
          if (functions[k].name === 'PowerOff') {
            harmonyPlatform.log('INFO - Activating PowerOff for ' + switchName);
            commandFunctions.push({
              key: 'PowerOff',
              value: functions[k].action,
            });
          } else if (functions[k].name === 'PowerOn') {
            harmonyPlatform.log('INFO - Activating  PowerOn for ' + switchName);
            commandFunctions.push({
              key: 'PowerOn',
              value: functions[k].action,
            });
          } else if (functions[k].name === 'PowerToggle') {
            harmonyPlatform.log(
              'INFO - Activating  PowerToggle for ' + switchName
            );
            commandFunctions.push({
              key: 'PowerToggle',
              value: functions[k].action,
            });
          }
        }
      }
    }

    return commandFunctions;
  },

  handleDefaultCommandMode: function(harmonyPlatform, controlGroup, device) {
    let services = [];

    let accessoryName = harmonyPlatform.name + '-' + device.label;
    let switchName = harmonyPlatform.devMode
      ? 'DEV' + device.label
      : device.label;

    harmonyPlatform.log('INFO - Discovered Device : ' + switchName);

    let foundToggle = false;
    let commandFunctions = this.populateCommands(
      harmonyPlatform,
      controlGroup,
      switchName
    );

    if (commandFunctions.some(e => e.key == 'PowerToggle')) {
      foundToggle = true;
    }

    if (commandFunctions.length == 0) {
      harmonyPlatform.log('Error - No function found for ' + switchName);
    } else {
      for (let j = 0, len = commandFunctions.length; j < len; j++) {
        if (
          (foundToggle && commandFunctions[j].key === 'PowerToggle') ||
          !foundToggle
        ) {
          let service = {
            controlService: new Service.Switch(
              switchName + '-' + commandFunctions[j].key
            ),
            characteristics: [Characteristic.On],
          };
          service.controlService.subtype =
            switchName + '-' + commandFunctions[j].key;
          service.controlService.id = device.id;
          service.type = HarmonyConst.DEVICE_TYPE;
          service.command = commandFunctions[j].value;
          services.push(service);

          if (harmonyPlatform.publishDevicesAsIndividualAccessories) {
            harmonyPlatform.log(
              'INFO - Adding Accessory : ' +
                accessoryName +
                '-' +
                commandFunctions[j].key
            );
            let myHarmonyAccessory = new HarmonyTools.HarmonyAccessory(
              services
            );
            myHarmonyAccessory.getServices = function() {
              return harmonyPlatform.getServices(myHarmonyAccessory);
            };
            myHarmonyAccessory.platform = harmonyPlatform;
            myHarmonyAccessory.name =
              accessoryName + '-' + commandFunctions[j].key;
            myHarmonyAccessory.model = device.model;
            myHarmonyAccessory.manufacturer = device.manufacturer;
            myHarmonyAccessory.serialNumber = harmonyPlatform.hubIP;
            harmonyPlatform._foundAccessories.push(myHarmonyAccessory);
            services = [];
          }
        }
      }
    }
    return services;
  },

  handleSpecificCommandMode: function(
    harmonyPlatform,
    commands,
    controlGroup,
    device
  ) {
    let services = [];

    let accessoryName = harmonyPlatform.name + '-' + device.label;
    let switchName = harmonyPlatform.devMode
      ? 'DEV' + device.label
      : device.label;

    harmonyPlatform.log('INFO - Discovered Device : ' + switchName);
    let functionsForSwitch = [];
    let functionsKey = '';

    for (let l = 1, len = commands.length; l < len; l++) {
      for (let j = 0, len = controlGroup.length; j < len; j++) {
        let functions = controlGroup[j].function;
        for (let k = 0, len = functions.length; k < len; k++) {
          let commandTosend = commands[l].split('|');

          if (functions[k].name === commandTosend[0]) {
            harmonyPlatform.log(
              'INFO - Activating  ' + commandTosend[0] + ' for ' + switchName
            );

            if (commandTosend.length === 2) {
              let fctWithDelay = functions[k].action + '|' + commandTosend[1];
              functionsForSwitch.push(fctWithDelay);
            } else {
              functionsForSwitch.push(functions[k].action);
            }
            functionsKey = functionsKey + commandTosend[0];
          }
        }
      }
    }

    if (functionsForSwitch.length === 0) {
      harmonyPlatform.log('Error - No function list found for ' + switchName);
    } else {
      let service = {
        controlService: new Service.Switch(switchName + '-' + functionsKey),
        characteristics: [Characteristic.On],
      };
      service.controlService.subtype = switchName + '-' + functionsKey;
      service.controlService.id = device.id;
      service.type = HarmonyConst.DEVICEMACRO_TYPE;
      service.command = JSON.stringify(functionsForSwitch);
      services.push(service);

      if (harmonyPlatform.publishDevicesAsIndividualAccessories) {
        harmonyPlatform.log(
          'INFO - Adding Accessory : ' + accessoryName + '-' + functionsKey
        );
        let myHarmonyAccessory = new HarmonyTools.HarmonyAccessory(services);
        myHarmonyAccessory.getServices = function() {
          return harmonyPlatform.getServices(myHarmonyAccessory);
        };
        myHarmonyAccessory.platform = harmonyPlatform;
        myHarmonyAccessory.name = accessoryName + '-' + functionsKey;
        myHarmonyAccessory.model = device.model;
        myHarmonyAccessory.manufacturer = device.manufacturer;
        myHarmonyAccessory.serialNumber = harmonyPlatform.hubIP;
        harmonyPlatform._foundAccessories.push(myHarmonyAccessory);
        services = [];
      }
    }

    return services;
  },

  getDevicesAccessories: function(harmonyPlatform, data) {
    let devices = data.data.device;
    //printing and storing
    this.printAndStoreCommands(harmonyPlatform, devices);

    if (
      harmonyPlatform.devicesToPublishAsAccessoriesSwitch &&
      harmonyPlatform.devicesToPublishAsAccessoriesSwitch.length > 0
    ) {
      harmonyPlatform.log('INFO - Loading devices...');
      var services = [];

      for (
        let c = 0,
          len = harmonyPlatform.devicesToPublishAsAccessoriesSwitch.length;
        c < len;
        c++
      ) {
        var commands = harmonyPlatform.devicesToPublishAsAccessoriesSwitch[
          c
        ].split(';');

        for (let i = 0, len = devices.length; i < len; i++) {
          if (devices[i].label === commands[0]) {
            //check  functions

            let controlGroup = devices[i].controlGroup;

            //default mode
            if (commands.length === 1) {
              services.push.apply(
                services,
                this.handleDefaultCommandMode(
                  harmonyPlatform,
                  controlGroup,
                  devices[i]
                )
              );
            }
            //specifc command or list mode
            else {
              services.push.apply(
                services,
                this.handleSpecificCommandMode(
                  harmonyPlatform,
                  commands,
                  controlGroup,
                  devices[i]
                )
              );
            }
          }
        }
      }

      if (
        !harmonyPlatform.publishDevicesAsIndividualAccessories &&
        services.length > 0
      ) {
        harmonyPlatform.log(
          'INFO - Adding Accessory : ' + harmonyPlatform.name + '-Devices'
        );
        let myHarmonyAccessory = new HarmonyTools.HarmonyAccessory(services);
        myHarmonyAccessory.getServices = function() {
          return harmonyPlatform.getServices(myHarmonyAccessory);
        };
        myHarmonyAccessory.platform = harmonyPlatform;
        myHarmonyAccessory.name = harmonyPlatform.name + '-Devices';
        myHarmonyAccessory.model = harmonyPlatform.name;
        myHarmonyAccessory.manufacturer = 'Harmony';
        myHarmonyAccessory.serialNumber = harmonyPlatform.hubIP;
        harmonyPlatform._foundAccessories.push(myHarmonyAccessory);
      }
    }
  },

  getHomeControlsAccessories: function(harmonyPlatform) {
    if (harmonyPlatform.publishHomeControlButtons) {
      harmonyPlatform.log('INFO - Loading home controls ...');

      var payload = {
        hubId: this._remoteId,
        timeout: 30,
        hbus: {
          cmd: 'harmony.automation?getstate',
          id: 0,
          params: {
            verb: 'get',
            format: 'json',
          },
        },
      };

      this.harmony._client
        .open()
        .then(() => this.harmony._client.sendRequest(payload))
        .then(response => {
          this.handleHomeControls(harmonyPlatform, response);
        })
        .catch(e => {
          harmonyPlatform.log('ERROR - getHomeControlsAccessories ' + e);
        });
    }
  },

  handleHomeControls: function(harmonyPlatform, data) {
    let homeControls = data.data;
    let services = [];

    harmonyPlatform.log('INFO - got Home Control : ' + JSON.stringify(data));
    for (var key in homeControls) {
      let switchName = key;
      let accessoryName = harmonyPlatform.name + '-' + switchName;

      if (harmonyPlatform.devMode) {
        switchName = 'DEV' + switchName;
      }

      harmonyPlatform.log('INFO - Discovered Home Control : ' + switchName);

      let service = {
        controlService: new Service.Switch(switchName),
        characteristics: [Characteristic.On],
      };
      service.controlService.subtype = switchName;
      service.controlService.id = key;
      service.type = HarmonyConst.HOME_TYPE;
      services.push(service);

      if (harmonyPlatform.publishSequencesAsIndividualAccessories) {
        harmonyPlatform.log('INFO - Adding Accessory : ' + accessoryName);
        let myHarmonyAccessory = new HarmonyTools.HarmonyAccessory(services);
        myHarmonyAccessory.getServices = function() {
          return harmonyPlatform.getServices(myHarmonyAccessory);
        };
        myHarmonyAccessory.platform = harmonyPlatform;
        myHarmonyAccessory.name = accessoryName;
        myHarmonyAccessory.model = harmonyPlatform.name;
        myHarmonyAccessory.manufacturer = 'Harmony';
        myHarmonyAccessory.serialNumber = harmonyPlatform.hubIP;
        harmonyPlatform._foundAccessories.push(myHarmonyAccessory);
        services = [];
      }
    }

    if (
      !harmonyPlatform.publishHomeControlsAsIndividualAccessories &&
      services.length > 0
    ) {
      harmonyPlatform.log(
        'INFO - Adding Accessory : ' + harmonyPlatform.name + '-HomeControls'
      );
      let myHarmonyAccessory = new HarmonyTools.HarmonyAccessory(services);
      myHarmonyAccessory.getServices = function() {
        return harmonyPlatform.getServices(myHarmonyAccessory);
      };
      myHarmonyAccessory.platform = harmonyPlatform;
      myHarmonyAccessory.name = harmonyPlatform.name + '-HomeControls';
      myHarmonyAccessory.model = harmonyPlatform.name;
      myHarmonyAccessory.manufacturer = 'Harmony';
      myHarmonyAccessory.serialNumber = harmonyPlatform.hubIP;
      harmonyPlatform._foundAccessories.push(myHarmonyAccessory);
    }
  },

  bindCharacteristicEvents: function(harmonyPlatform, characteristic, service) {
    characteristic.on(
      'set',
      function(value, callback) {
        //send command
        if (value) {
          if (service.type === HarmonyConst.DEVICE_TYPE) {
            let command = service.command;
            this.sendCommand(harmonyPlatform, command);
          } else if (service.type === HarmonyConst.DEVICEMACRO_TYPE) {
            let commands = JSON.parse(service.command);
            HarmonyTools.processCommands(this, harmonyPlatform, commands);
          } else if (service.type === HarmonyConst.SEQUENCE_TYPE) {
            let command = '{"sequenceId":"' + service.controlService.id + '"}';
            this.sendCommand(harmonyPlatform, command);
          } else if (service.type === HarmonyConst.HOME_TYPE) {
            let command =
              '{"state":{"' +
              service.controlService.id +
              '":{"on":' +
              value +
              '}}}}}';
            this.sendAutomationCommand(harmonyPlatform, command);
          }
        }

        // In order to behave like a push button reset the status to off
        setTimeout(function() {
          characteristic.updateValue(false, undefined);
        }, HarmonyConst.DELAY_FOR_STATELESS_SWITCH_UPDATE);

        callback();
      }.bind(this)
    );

    characteristic.on(
      'get',
      function(callback) {
        this.handleCharacteristicUpdate(
          harmonyPlatform,
          characteristic,
          false,
          callback
        );
      }.bind(this)
    );
  },

  sendCommand: function(harmonyPlatform, commandToSend) {
    if (!commandToSend) {
      harmonyPlatform.log.debug('INFO - sendCommand : Command not available ');
      return;
    }
    harmonyPlatform.log.debug('INFO - sendingCommand' + commandToSend);

    return this.harmony
      .sendCommands(commandToSend)
      .then(data => {
        harmonyPlatform.log.debug(
          'INFO - sendCommand done' + JSON.stringify(data)
        );
      })
      .catch(e => {
        harmonyPlatform.log('ERROR - sendCommand : ' + e);
      });
  },

  sendAutomationCommand: function(harmonyPlatform, commandToSend) {
    if (!commandToSend) {
      harmonyPlatform.log.debug(
        'INFO - sendAutomationCommand : Command not available '
      );
      return;
    }
    harmonyPlatform.log.debug(
      'INFO - sendingAutomationCommand' + commandToSend
    );

    var payload = {
      hubId: this._remoteId,
      timeout: 30,
      hbus: {
        cmd: 'harmony.automation?setstate',
        id: 0,
        params: commandToSend,
      },
    };

    return this.harmony._client
      .open()
      .then(() => this.harmony._client.sendRequest(payload))
      .then(data => {
        harmonyPlatform.log.debug(
          'INFO - sendingAutomationCommand done' + JSON.stringify(data)
        );
      })
      .catch(e => {
        harmonyPlatform.log('ERROR - sendingAutomationCommand : ' + e);
      });
  },
};
