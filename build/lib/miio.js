"use strict";
const crypto = require("node:crypto");
const dgram = require("node:dgram");
const EventEmitter = require("node:events");
const pingMsg = _str2hex("21310020ffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
let adapter = null;
class Miio extends EventEmitter {
  constructor(adapterInstance) {
    super();
    adapter = adapterInstance;
    this.ownPort = adapter.config.ownPort || 53421;
    this.port = adapter.config.port || 54321;
    this.ip = adapter.config.ip;
    this.token = _str2hex(adapter.config.token);
    adapter.log.debug(`MIIO: Config: ip:${this.ip} token: ${adapter.config.token.substr(0, 10)}XXXXXXXXX`);
    this.connected = null;
    this.pingTimeout = 1e4;
    this.packet = new _Packet(this.token);
    this.timeout = null;
    this.globalTimeouts = {};
    this.server = dgram.createSocket("udp4");
    try {
      this.server.bind(this.ownPort);
    } catch (e) {
      return adapter.log.error(`Cannot open UDP port, please make sure port is not in use: ${e}`);
    }
    this.server.on("listening", () => {
      const address = this.server.address();
      adapter.log.debug(`server started on ${address.address}:${address.port}`);
      this.__sendPing();
    });
    this.server.on("error", (err) => {
      adapter.log.error(`UDP error: ${err}`);
      try {
        this.server.close();
      } catch (err2) {
        adapter.log.debug(err2);
      }
      process.exit();
    });
    this.server.on("close", () => {
      adapter.log.error("Socket Close");
      Object.keys(this.globalTimeouts).forEach(
        (id) => this.globalTimeouts[id] && clearTimeout(this.globalTimeouts[id])
      );
      this.globalTimeouts = {};
    });
  }
  close(callback) {
    Object.keys(this.globalTimeouts).forEach(
      (id) => this.globalTimeouts[id] && clearTimeout(this.globalTimeouts[id])
    );
    this.globalTimeouts = {};
    if (this.server) {
      this.globalTimeouts["nextPing"] && clearTimeout(this.globalTimeouts["nextPing"]);
      this.globalTimeouts["pingTimeout"] && clearTimeout(this.globalTimeouts["pingTimeout"]);
      try {
        this.server.close(callback);
      } catch (err) {
        adapter.log.debug(err);
      }
      return;
    }
    typeof callback === "function" && callback();
  }
  __sendPing() {
    const checkAnswer = (msg, rinfo) => {
      if (msg.length === 32 && rinfo.port === parseInt(this.port)) {
        clearTimeout(this.globalTimeouts["pingTimeout"]);
        clearTimeout(this.globalTimeouts["nextPing"]);
        adapter.log.debug(`Receive <<< Helo <<< ${msg.toString("hex")}`);
        this.server.removeListener("message", checkAnswer);
        if (!this.connected) {
          if (this.connected === null) {
            this.emit("connect");
          }
          this.connected = true;
        }
        this.packet.setRaw(msg);
        const now = Math.floor(Date.now() / 1e3);
        const messageTime = parseInt(this.packet.stamprec.toString("hex"), 16);
        this.packet.timediff = messageTime - now === -1 ? 0 : messageTime - now;
        if (this.packet.timediff !== 0) {
          adapter.log.debug(
            `Time difference between Mihome Vacuum and ioBroker: ${this.packet.timediff} sec`
          );
        }
        this.globalTimeouts["nextPing"] = setTimeout(() => {
          this.globalTimeouts["nextPing"] = null;
          this.__sendPing();
        }, this.pingTimeout);
      }
    };
    this.server.on("message", checkAnswer);
    try {
      this.server.send(pingMsg, 0, pingMsg.length, this.port, this.ip, (err) => {
        if (err) {
          adapter.log.warn(`Helo message: ${err}`);
          this.server.removeListener("message", checkAnswer);
          this.globalTimeouts["nextPing"] = setTimeout(() => {
            this.globalTimeouts["nextPing"] = null;
            this.__sendPing();
          }, this.pingTimeout);
        } else {
          this.globalTimeouts["pingTimeout"] = setTimeout(() => {
            this.globalTimeouts["pingTimeout"] = null;
            adapter.log.debug("Helo message Timeout");
            this.connected = false;
            this.server.removeListener("message", checkAnswer);
            this.globalTimeouts["nextPing"] = setTimeout(() => {
              this.globalTimeouts["nextPing"] = null;
              this.__sendPing();
            }, this.pingTimeout);
          }, 2e3);
        }
      });
    } finally {
    }
  }
  /**
   * @async
   * @param method the methode you want to request
   * @param params the params as arra eg: ["peter","Blaubeere"]
   * @returns return a obj with the answer from the robot
   */
  async sendMessage(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        adapter.log.debug("your device is not connected, but this could be temporary");
        return resolve({});
      }
      if (this.packet.msgCounter > 1e4) {
        this.packet.msgCounter = 1;
      }
      const msgCounter = this.packet.msgCounter++;
      const rawMsg = this.packet.getRaw_fast(this._buildMsg(method, params, msgCounter));
      const checkAnswer = (msg, rinfo) => {
        if (msg.length !== 32 && rinfo.port === parseInt(this.port)) {
          this.packet.setRaw(msg);
          try {
            const answer = JSON.parse(this.packet.getPlainData());
            if (answer.id === msgCounter) {
              clearTimeout(this.globalTimeouts[`sendMessage${msgCounter}`]);
              delete this.globalTimeouts[`sendMessage${msgCounter}`];
              this.server.removeListener("message", checkAnswer);
              adapter.setConnection(true);
              adapter.log.debug(`MIIO RECIVE: ${JSON.stringify(answer)}`);
              resolve(answer);
            }
          } catch (error) {
            adapter.log.debug(`MIIO ERROR: ${error}`);
            try {
              const plainData = this.packet.getPlainData();
              adapter.log.debug(`MIIO MESSAGE CANT PARSE ANSWER: ${plainData}`);
            } catch (error2) {
              adapter.log.debug(`MIIO MESSAGE CANT PARSE ANSWER: ${error2}`);
            }
            return resolve({});
          }
        }
      };
      this.server.on("message", checkAnswer);
      try {
        this.server.send(rawMsg, 0, rawMsg.length, parseInt(this.port), adapter.config.ip, (err) => {
          if (err) {
            adapter.log.debug(`MIIO cannot send: ${err}`);
            this.server.removeListener("message", checkAnswer);
            return resolve({});
          }
          this.globalTimeouts[`sendMessage${msgCounter}`] = setTimeout(
            (cnt) => {
              delete this.globalTimeouts[`sendMessage${cnt}`];
              this.server.removeListener("message", checkAnswer);
              adapter.log.debug(
                "your device is connected, but didn't answer yet - sometime connection is broken and can take up to 10 Minutes"
              );
              resolve({});
            },
            2e3,
            msgCounter
          );
        });
      } catch (err) {
        return reject(err);
      }
    }).catch((err) => {
      adapter.log.error(`sendMessage throws error ==>${err}`);
      return err;
    });
  }
  /* function is never used
  	 * @async
  	 * @param {string} ssid the methode you want to request
  	 * @param {Array} piid the params as arra eg: ["peter","Blaubeere"]
  	 * @param {Array} params the params as arra eg: ["peter","Blaubeere"]
  	 * @return {promise} return a obj with the answer from the robot
  	 
  	async miotGet(ssid, piid, params) {
  		return new Promise((resolve, reject) => {
  
  			this.globalTimeouts['sendMessage' + this.packet.msgCounter] && delete this.globalTimeouts['sendMessage' + this.packet.msgCounter];
  
  			if(this.packet.msgCounter > 10000){
  				this.packet.msgCounter = 1
  			}
  			const msgCounter = this.packet.msgCounter++;
  			const rawMsg = this.packet.getRaw_fast(this._buildMsg('get_properties', [{
  				did: '',
  				siid: ssid,
  				piid: piid
  			}], msgCounter));
  
  			const checkAnswer = (msg, rinfo) => {
  				if (msg.length !== 32 && rinfo.port === parseInt(this.port)) {
  					this.packet.setRaw(msg);
  					try {
  						const answer = JSON.parse(this.packet.getPlainData());
  
  						if (answer.id === msgCounter) {
  							clearTimeout(this.globalTimeouts['sendMessage' + msgCounter]);
  							delete this.globalTimeouts['sendMessage' + msgCounter];
  							this.server.removeListener('message', checkAnswer);
  
  							//connection is true
  							adapter.setConnection(true);
  							adapter.log.debug('MIIO RECIVE: ' + JSON.stringify(answer));
  							resolve(answer);
  						}
  					} catch (error) {
  						reject('MIIO MESSAGE CANT PARSE ANSWER: ');
  					}
  				}
  			};
  
  			this.server.on('message', checkAnswer);
  
  			try {
  				this.server.send(rawMsg, 0, rawMsg.length, parseInt(this.port), adapter.config.ip, err => {
  					if (err) {
  						adapter.log.debug(`MIIO cannot send: ${err}`);
  						this.server.removeListener('message', checkAnswer);
  						return reject(err);
  					}
  					this.globalTimeouts['sendMessage' + msgCounter] = setTimeout(cnt => {
  						delete this.globalTimeouts['sendMessage' + cnt];
  						adapter.log.debug('Receive Timeout<<< ');
  						this.server.removeListener('message', checkAnswer);
  						reject('MESSAGE TIMEOUT');
  					}, 2000, msgCounter);
  				});
  			} catch (err) {
  				reject(err);
  			}
  		});
  	}
  */
  _buildMsg(method, params, msgCounter) {
    const message = {};
    if (method) {
      message.id = msgCounter;
      message.method = method;
      if (!(params === "" || params === void 0 || params === null || params instanceof Array && params.length === 1 && params[0] === "")) {
        message.params = params;
      }
    } else {
      adapter.log.warn("Could not build message without arguments");
    }
    const messageStr = JSON.stringify(message).replace('["[', "[[").replace(']"]', "]]").replace(/\]","\[/g, "],[");
    adapter.log.debug(`Message= ${messageStr}`);
    return messageStr;
  }
}
function _Packet(token) {
  this.magic = Buffer.alloc(2);
  this.len = Buffer.alloc(2);
  this.unknown = Buffer.alloc(4);
  this.serial = Buffer.alloc(4);
  this.stamp = Buffer.alloc(4);
  this.checksum = Buffer.alloc(16);
  this.data = Buffer.alloc(0);
  this.token = Buffer.alloc(16);
  this.key = Buffer.alloc(16);
  this.iv = Buffer.alloc(16);
  this.ioskey = Buffer.from("00000000000000000000000000000000", "hex");
  this.msgCounter = 1;
  this.stamprec = Buffer.alloc(4);
  this.timediff = 0;
  this.setHelo = function() {
    this.magic = Buffer.from("2131", "hex");
    this.len = Buffer.from("0020", "hex");
    this.unknown = Buffer.from("FFFFFFFF", "hex");
    this.serial = Buffer.from("FFFFFFFF", "hex");
    this.stamp = Buffer.from("FFFFFFFF", "hex");
    this.checksum = Buffer.from("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF", "hex");
    this.data = Buffer.alloc(0);
  };
  this.setIosToken = function(iosToken) {
    const _iosToken = iosToken.toString("hex");
    const encrypted = Buffer.from(_iosToken.substr(0, 64), "hex");
    const decipher = crypto.createDecipheriv("aes-128-ecb", this.ioskey, "");
    decipher.setAutoPadding(false);
    const decrypted = decipher.update(encrypted, "binary", "ascii");
    adapter.log.debug(`Ios Token decrypted to: ${decrypted}`);
    return _str2hex(decrypted);
  };
  this.getRaw_fast = function(plainData) {
    const cipher = crypto.createCipheriv("aes-128-cbc", this.key, this.iv);
    let crypted = cipher.update(plainData, "utf8", "binary");
    crypted += cipher.final("binary");
    crypted = Buffer.from(crypted, "binary");
    this.data = crypted;
    this.stamp = "00000000";
    this.stamp += (Math.floor(Date.now() / 1e3) + this.timediff).toString(16);
    this.stamp = this.stamp.substring(this.stamp.length - 8, this.stamp.length);
    if (this.data.length > 0) {
      this.len = Buffer.from(decimalToHex(this.data.length + 32, 4), "hex");
      const zwraw = Buffer.from(
        this.magic.toString("hex") + this.len.toString("hex") + this.unknown.toString("hex") + this.serial.toString("hex") + this.stamp.toString("hex") + this.token.toString("hex") + this.data.toString("hex"),
        "hex"
      );
      this.checksum = _md5(zwraw);
    }
    return Buffer.from(
      this.magic.toString("hex") + this.len.toString("hex") + this.unknown.toString("hex") + this.serial.toString("hex") + this.stamp.toString("hex") + this.checksum.toString("hex") + this.data.toString("hex"),
      "hex"
    );
  };
  this.setRaw = function(raw) {
    const rawhex = raw.toString("hex");
    this.magic = Buffer.from(rawhex.substr(0, 4), "hex");
    this.len = Buffer.from(rawhex.substr(4, 4), "hex");
    this.unknown = Buffer.from(rawhex.substr(8, 8), "hex");
    this.serial = Buffer.from(rawhex.substr(16, 8), "hex");
    this.stamprec = Buffer.from(rawhex.substr(24, 8), "hex");
    this.checksum = Buffer.from(rawhex.substr(32, 32), "hex");
    this.data = Buffer.from(rawhex.substr(64), "hex");
  };
  this.getPlainData = function() {
    const decipher = crypto.createDecipheriv("aes-128-cbc", this.key, this.iv);
    let dec = decipher.update(this.data, "binary", "utf8");
    dec += decipher.final("utf8");
    dec = dec.substring(0, dec.length - 1);
    if (!dec.endsWith("}")) {
      dec += "}";
    }
    return dec;
  };
  function _md5(data) {
    return Buffer.from(crypto.createHash("md5").update(data).digest("hex"), "hex");
  }
  this.setToken = function(token2) {
    if (token2.length === 48) {
      this.token = this.setIosToken(token2);
    } else {
      this.token = token2;
    }
    this.key = _md5(this.token);
    this.iv = _md5(Buffer.from(this.key.toString("hex") + this.token.toString("hex"), "hex"));
  };
  this.setHelo();
  if (token) {
    this.setToken(token);
  }
  return this;
}
function decimalToHex(decimal, chars) {
  return (decimal + Math.pow(16, chars)).toString(16).slice(-chars).toUpperCase();
}
function _str2hex(str) {
  str = str.replace(/\s/g, "");
  const buf = Buffer.alloc(str.length / 2);
  for (let i = 0; i < str.length / 2; i++) {
    buf[i] = parseInt(str[i * 2] + str[i * 2 + 1], 16);
  }
  return buf;
}
module.exports = Miio;
//# sourceMappingURL=miio.js.map
