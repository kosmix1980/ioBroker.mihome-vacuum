"use strict";
const utils = require("@iobroker/adapter-core");
const XiaomiCloudConnector = require("./lib/XiaomiCloudConnector");
const miio = require("./lib/miio");
const objects = require("./lib/objects");
const ViomiManager = require("./lib/viomi");
const VacuumManager = require("./lib/vacuum");
const DreameManager = require("./lib/dreame");
let Miio;
let vacuum = null;
let XiaomiApi = null;
class MihomeVacuum extends utils.Adapter {
  constructor(options) {
    super({
      ...options,
      name: "mihome-vacuum"
    });
    this.unsupportedFeatures = "|";
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async main() {
    this.config.port = parseInt(this.config.port, 10) || 54321;
    this.config.ownPort = parseInt(this.config.ownPort, 10) || 53421;
    this.config.pingInterval = parseInt(this.config.pingInterval, 10) || 2e4;
    if (this.config.pingInterval < 1e4) {
      this.config.pingInterval = 1e4;
    }
    if (!this.config.token) {
      this.log.warn("Token not specified!");
      return;
    }
    await Promise.all(
      objects.deviceInfo.map(async (o) => {
        await this.setObjectNotExistsAsync(`deviceInfo${o._id ? `.${o._id}` : ""}`, o);
        this.log.debug(`Create State for deviceInfo${o._id}`);
      })
    );
    Miio = new miio(this);
    Miio.on("connect", async () => {
      this.log.debug("MAIN: Connected to device, try to get model..");
      this.setState("info.IPAddress", {
        // @ts-expect-error var not defined
        val: this.config.ip,
        ack: true
      });
      await this.getModel();
      if (!vacuum) {
        return;
      }
      this.subscribeStates("*");
    });
    if (this.config.enableSelfCommands) {
      objects.customCommands.map(
        async (o) => await this.setObjectNotExistsAsync(`control${o._id ? `.${o._id}` : ""}`, o)
      );
    } else {
      objects.customCommands.map((o) => this.delObj(`control${o._id ? `.${o.id}` : ""}`));
    }
    if (this.config.enableAlexa) {
      this.log.info("IOT enabled, create state");
      objects.iotState.map((o) => this.setObjectNotExistsAsync(`control${o._id ? `.${o._id}` : ""}`, o));
    } else {
      this.log.info("IOT disabled, delete state");
      objects.iotState.map(async (o) => await this.delObj(`control${o._id ? `.${o.id}` : ""}`));
    }
    this.getStateAsync("deviceInfo.unsupported").then((obj) => {
      if (obj && typeof obj.val == "string") {
        this.unsupportedFeatures = obj.val;
        if (!this.unsupportedFeatures.endsWith("|")) {
          this.unsupportedFeatures.concat("|");
        }
        if (!this.unsupportedFeatures.startsWith("|")) {
          this.unsupportedFeatures = `|${this.unsupportedFeatures}`;
        }
        if (this.unsupportedFeatures.indexOf("|segemntCleanRepeat|") >= 0) {
          this.unsupportedFeatures = this.unsupportedFeatures.replace("|segemntCleanRepeat|", "|");
          this.setStateAsync("deviceInfo.unsupported", this.unsupportedFeatures, true);
          this.log.info("cleared persisted segemntCleanRepeat flag; native multi-pass will be tried again");
        }
      }
    });
  }
  isUnsupportedFeature(key) {
    return this.unsupportedFeatures.indexOf(`|${key}|`) >= 0;
  }
  setUnsupportedFeature(key) {
    if (this.unsupportedFeatures.indexOf(`|${key}|`) == -1) {
      this.unsupportedFeatures += `${key}|`;
      this.setStateAsync("deviceInfo.unsupported", this.unsupportedFeatures, true);
    }
  }
  /**
   * first communication to find out the model
   */
  async getModel() {
    let DeviceModel;
    let DeviceData;
    for (let i = 0; i < 5; i++) {
      DeviceData = await this.getModelFromApi();
      this.log.debug(`Get Device data..${i}`);
      if (DeviceData) {
        this.log.debug(
          `Get Device data from robot.. ${JSON.stringify(DeviceData.result).replace(/"token":"(.{10}).+"/g, '"token":"$1XXXXXX"')}`
        );
        await this.setModelInfoObject(DeviceData.result);
        DeviceModel = DeviceData.result.model;
        await this.setConnection(true);
        break;
      }
    }
    if (!DeviceData) {
      this.log.error(
        "YOUR DEVICE IS CONNECTED BUT DID NOT ANSWER YET - CONNECTION CAN TAKE UP TO 10 MINUTES - PLEASE BE PATIENT AND DO NOT TURN THE ADAPTER OFF"
      );
      DeviceModel = this.config.model;
      if (DeviceModel) {
        this.log.warn("No Answer for DeviceModel use model from Config");
      } else {
        const objModel = await this.getStateAsync("deviceInfo.model");
        if (objModel && objModel.val) {
          DeviceModel = objModel.val;
          this.log.warn("No Answer for DeviceModel use old one");
        }
      }
    }
    if (!DeviceModel) {
      this.log.error("could not find model, please try again later or set manually in config");
      return;
    }
    this.log.debug(`DeviceModel set to: ${DeviceModel}`);
    const manager = this.getManager(DeviceModel, this.config.manager);
    if (manager) {
      this.device = DeviceModel;
      vacuum = new manager(this, Miio);
    }
  }
  getManager(model, configuredManager) {
    const mangerList = {
      viomi: ViomiManager,
      roborock: VacuumManager,
      rockrobo: VacuumManager,
      dreame: DreameManager,
      xiaomi: DreameManager
    };
    let manager;
    if (configuredManager) {
      manager = mangerList[configuredManager];
      if (!manager) {
        this.log.error(`selected manager ${configuredManager} is not supported`);
      }
    } else if (model) {
      manager = mangerList[model.split(".")[0]];
      if (!manager) {
        this.log.error(`Model ${model} not supported! You can try to setup manually a library in settings.`);
      }
    }
    return manager;
  }
  /**
   * function to set DeviceInfo
   *
   * @param deviceInfo Model name from Xiaomi eg: viomi.vacuum.v8
   */
  async setModelInfoObject(deviceInfo) {
    await this.setStateAsync("deviceInfo.model", {
      val: deviceInfo.model,
      ack: true
    });
    await this.setStateAsync("deviceInfo.fw_ver", {
      val: deviceInfo.fw_ver,
      ack: true
    });
    await this.setStateAsync("deviceInfo.mac", {
      val: deviceInfo.mac,
      ack: true
    });
    return true;
  }
  /**
   * Function to set the connection indicator
   *
   * @param indicator could be true or false
   */
  async setConnection(indicator) {
    await this.setStateAsync("info.connection", {
      val: indicator,
      ack: true
    });
  }
  async getModelFromApi() {
    try {
      const DeviceData = await Miio.sendMessage("miIO.info");
      this.log.debug(
        `GETMODELFROMAPI:Data: ${JSON.stringify(DeviceData).replace(
          /"token":"(.{10}).+"/g,
          '"token":"$1XXXXXX"'
        )}`
      );
      return DeviceData.result ? DeviceData : null;
    } catch (error) {
      this.log.debug(`getModelFromApi: ${error}`);
      return null;
    }
  }
  /**
   * delete async function
   *
   * @param id id
   */
  async delObj(id) {
    try {
      await this.delObjectAsync(id);
    } catch (error) {
      this.log.debug(`delObj: ${error}`);
    }
  }
  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    this.setConnection(false);
    this.main();
  }
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   *
   * @param callback function
   */
  async onUnload(callback) {
    try {
      if (vacuum) {
        await vacuum.close();
      }
      if (Miio) {
        Miio.close(callback);
      } else {
        callback();
      }
    } catch (e) {
      this.log.debug(`onUNload: ${e}`);
      callback();
    }
  }
  // If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
  // You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
  // /**
  //  * Is called if a subscribed object changes
  //  * @param {string} id
  //  * @param {ioBroker.Object | null | undefined} obj
  //  */
  // onObjectChange(id, obj) {
  //     if (obj) {
  //         // The object was changed
  //         this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
  //     } else {
  //         // The object was deleted
  //         this.log.info(`object ${id} deleted`);
  //     }
  // }
  /**
   * Is called if a subscribed state changes
   *
   * @param id id
   * @param state state
   */
  async onStateChange(id, state) {
    if (!state || state.ack) {
      return;
    }
    const terms = id.split(".");
    const command = terms.pop();
    if (command === "X_send_command") {
      const values = (state.val || "").toString().trim().split(";");
      let params = [""];
      if (values[1]) {
        try {
          params = JSON.parse(values[1]);
        } catch (e) {
          this.log.debug(`onStateChange: ${e}`);
          return this.setState(
            "control.X_get_response",
            `Could not send these params because its not in JSON format: ${values[1]}`,
            true
          );
        }
        this.log.info(`send message: Method: ${values[0]} Params: ${values[1]}`);
      } else {
        this.log.info(`send message: Method: ${values[0]}`);
      }
      this.setStateAsync(id, state.val, true);
      try {
        const DeviceData = await Miio.sendMessage(values[0], params);
        this.log.debug(`Get self send data: ${JSON.stringify(DeviceData)}`);
        this.setStateAsync("control.X_get_response", JSON.stringify(DeviceData.result), true);
      } catch (error) {
        this.setStateAsync("control.X_get_response", `[${error}]`, true);
      }
    }
    if (vacuum) {
      vacuum.stateChange(id, state);
    }
  }
  /**
   * Persist Xiaomi cloud session (serviceToken/ssecurity) for map access.
   *
   * @param {object} session
   */
  async persistCloudSession(session) {
    if (!session) {
      return false;
    }
    let payload = JSON.stringify(session);
    try {
      if (typeof this.encrypt === "function") {
        payload = this.encrypt(payload);
      }
    } catch (encryptErr) {
      this.log.debug(`Cloud session encrypt skipped: ${encryptErr.message}`);
    }
    await this.setStateAsync("deviceInfo.cloudSession", payload, true);
    await this.setStateAsync("deviceInfo.cloudSessionStatus", "active", true);
    this.log.info("Xiaomi cloud session saved for map access");
    return true;
  }
  /**
   * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
   * Using this method requires "common.message" property to be set to true in io-package.json
   *
   * @param obj message object
   */
  async onMessage(obj) {
    if (typeof obj === "object" && obj.message) {
      if (obj.command === "send") {
        this.log.info("send command");
        if (obj.callback) {
          this.sendTo(obj.from, obj.command, "Message received", obj.callback);
        }
      }
    }
    const respond = (response) => obj.callback && this.sendTo(obj.from, obj.command, response, obj.callback);
    if (obj) {
      switch (obj.command) {
        case "discovery": {
          const authObj = obj.message && obj.message.authObj || {};
          const captchaCode = typeof authObj.captCode === "string" && authObj.captCode && authObj.captCode !== "true" ? String(authObj.captCode).trim() : "";
          const twoFactorCode = typeof authObj.twoFactorCode === "string" ? String(authObj.twoFactorCode).trim() : "";
          try {
            let result;
            if (XiaomiApi && XiaomiApi.pending2FA && twoFactorCode) {
              this.log.info("CloudApi: 2FA ticket retry on existing session");
              result = await XiaomiApi.continueWith2FA(twoFactorCode);
            } else if (XiaomiApi && XiaomiApi.pendingCaptcha && captchaCode) {
              this.log.info("CloudApi: captcha retry on existing session");
              if (authObj.password) {
                XiaomiApi.password = authObj.password;
              }
              result = await XiaomiApi.continueWithCaptcha(captchaCode);
            } else {
              if (!XiaomiApi || authObj.username && XiaomiApi.username && XiaomiApi.username !== authObj.username || authObj.reset) {
                XiaomiApi = new XiaomiCloudConnector(this.log, authObj);
              } else {
                const { cookies, ...rest } = authObj;
                XiaomiApi.init(rest);
              }
              result = await XiaomiApi.login();
            }
            if (result && result.ok) {
              const session = result.session || XiaomiApi.exportSession();
              if (session) {
                await this.persistCloudSession(session);
                if (vacuum && vacuum.Map && vacuum.Map.cloudConnector) {
                  vacuum.Map.cloudConnector.importSession(session);
                  vacuum.mapReady.login = true;
                }
              }
              const data = await XiaomiApi.getDevices(obj.message.server);
              this.log.debug(`discover__${JSON.stringify(data)}`);
              respond(data);
              return;
            }
            if (result && result.captchaUrl) {
              await this.setStateAsync("deviceInfo.cloudSessionStatus", "captcha_required", true);
            } else if (result && result.pending2FA) {
              await this.setStateAsync("deviceInfo.cloudSessionStatus", "2fa_required", true);
            }
            respond(result);
          } catch (result) {
            this.log.info(`discover ${result && result.err || result}`);
            respond(result);
          }
          return;
        }
        case "clearCloudSession": {
          XiaomiApi = null;
          await this.setStateAsync("deviceInfo.cloudSession", "", true);
          await this.setStateAsync("deviceInfo.cloudSessionStatus", "none", true);
          if (vacuum && vacuum.Map && vacuum.Map.cloudConnector) {
            vacuum.Map.cloudConnector.serviceToken = null;
            vacuum.Map.cloudConnector.ssecurity = null;
            vacuum.Map.cloudConnector.userId = null;
            vacuum.mapReady.login = false;
          }
          respond({ ok: true });
          return;
        }
        // ======================================================================
        default:
          if (!vacuum) {
            return respond({
              error: new Error("Not initialized")
            });
          }
          respond(await vacuum.onMessage(obj));
          return;
      }
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new MihomeVacuum(options);
} else {
  (() => new MihomeVacuum())();
}
//# sourceMappingURL=main.js.map
