const axios = require('axios');
const crypto = require('node:crypto');
const qs = require('qs');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');

/**
 * Xiaomi cloud connector with real cookie jar (like Python requests.Session),
 * captcha challenge support and exportable session tokens for map access.
 */
class XiaomiCloudConnector {
    constructor(logger, authObj) {
        this.logger = logger;
        this.agent = this.generateAgent();
        this.deviceId = this.generateDeviceId();

        this.username = null;
        this.password = null;

        this._sign = null;
        this.captCode = false;
        this.ssecurity = null;
        this.userId = null;
        this.location = null;

        this.serviceToken = null;
        this.pendingCaptcha = false;
        this.pending2FA = false;
        /** @type {null|{context: string, flag: string, method: string}} */
        this.twoFactor = null;

        /** @type {import('tough-cookie').CookieJar} */
        this.jar = new CookieJar();
        this.session = wrapper(
            axios.create({
                jar: this.jar,
                withCredentials: true,
                maxRedirects: 0,
                validateStatus: status => status >= 200 && status < 400,
            }),
        );

        this.homeIds = null;
        this.init(authObj);
        this.primeJar();
    }

    /**
     * Seed jar with sdkVersion/deviceId like the official token extractor.
     */
    primeJar() {
        try {
            this.jar.setCookieSync(`sdkVersion=accountsdk-18.8.15; Domain=xiaomi.com; Path=/`, 'https://account.xiaomi.com');
            this.jar.setCookieSync(`sdkVersion=accountsdk-18.8.15; Domain=mi.com; Path=/`, 'https://account.xiaomi.com');
            this.jar.setCookieSync(`deviceId=${this.deviceId}; Domain=xiaomi.com; Path=/`, 'https://account.xiaomi.com');
            this.jar.setCookieSync(`deviceId=${this.deviceId}; Domain=mi.com; Path=/`, 'https://account.xiaomi.com');
        } catch (err) {
            // @ts-expect-error message
            this.logger.debug(`CloudApi cookie prime: ${err.message}`);
        }
    }

    init(authObj) {
        if (authObj) {
            if (authObj.username) {
                this.username = authObj.username;
            }
            if (authObj.password) {
                this.password = authObj.password;
            }
            if (authObj._sign) {
                this._sign = authObj._sign;
            }
            if (authObj.captCode) {
                this.captCode = authObj.captCode;
            }
            if (authObj.deviceId) {
                this.deviceId = authObj.deviceId;
            }
            if (authObj.agent) {
                this.agent = authObj.agent;
            }
            if (authObj.ssecurity) {
                this.ssecurity = authObj.ssecurity;
            }
            if (authObj.userId) {
                this.userId = authObj.userId;
            }
            if (authObj.serviceToken) {
                this.serviceToken = authObj.serviceToken;
            }
            if (authObj.jarData) {
                try {
                    this.jar = CookieJar.fromJSON(authObj.jarData);
                    this.session = wrapper(
                        axios.create({
                            jar: this.jar,
                            withCredentials: true,
                            maxRedirects: 0,
                            validateStatus: status => status >= 200 && status < 400,
                        }),
                    );
                } catch (err) {
                    // @ts-expect-error message
                    this.logger.warn(`CloudApi could not restore cookie jar: ${err.message}`);
                }
            }
        }
        this.commonCookies = `sdkVersion=accountsdk-18.8.15; deviceId=${this.deviceId};`;
    }

    loggedIn() {
        return !!(this.serviceToken && this.ssecurity && this.userId);
    }

    /**
     * Read a cookie value from the jar for account.xiaomi.com.
     *
     * @param {string} name
     */
    getCookie(name) {
        try {
            const cookies = this.jar.getCookiesSync('https://account.xiaomi.com');
            const found = cookies.find(c => c.key.toLowerCase() === name.toLowerCase());
            return found ? found.value : null;
        } catch {
            return null;
        }
    }

    exportSession() {
        if (!this.loggedIn()) {
            return null;
        }
        return {
            username: this.username,
            userId: this.userId,
            ssecurity: this.ssecurity,
            serviceToken: this.serviceToken,
            deviceId: this.deviceId,
            agent: this.agent,
            jarData: this.jar.toJSON(),
            savedAt: Date.now(),
        };
    }

    /**
     * @param {object} session
     */
    importSession(session) {
        if (!session || typeof session !== 'object') {
            return false;
        }
        this.init(session);
        this.primeJar();
        return this.loggedIn();
    }

    async loginStep1() {
        if (this._sign) {
            return { ok: true };
        }
        this.logger.debug('CloudApi-CloudApi-Step 1: Getting sign token');
        const url = 'https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiio&_json=true';
        const headers = {
            'User-Agent': this.agent,
            'Content-Type': 'application/x-www-form-urlencoded',
        };
        try {
            this.jar.setCookieSync(
                `userId=${this.username}; Domain=account.xiaomi.com; Path=/`,
                'https://account.xiaomi.com',
            );
            const response = await this.session.get(url, {
                headers,
            });

            const body = this.parseJSON(response.data);
            if (response.status === 200 && body._sign) {
                this._sign = body._sign;
                return { ok: true };
            }
            // Already logged in via cookies?
            if (body.ssecurity && body.userId) {
                this.ssecurity = body.ssecurity;
                this.userId = body.userId;
                this.location = body.location;
                return { ok: true };
            }
        } catch (err) {
            // @ts-expect-error err.message not defined
            this.logger.error('CloudApi-Login Step 1 failed:', err.message);
            // @ts-expect-error err.message not defined
            return { err: err.message };
        }
        return { err: 'Could not get signature' };
    }

    async loginStep2() {
        if (this.userId && this.ssecurity) {
            return { ok: true };
        }
        if (!this.password) {
            return { err: 'password missing for cloud login' };
        }
        this.logger.debug('CloudApi-Step 2: Authenticating user');
        const url = 'https://account.xiaomi.com/pass/serviceLoginAuth2';
        const hash = crypto.createHash('md5').update(this.password).digest('hex').toUpperCase();
        const headers = {
            'User-Agent': this.agent,
            'Content-Type': 'application/x-www-form-urlencoded',
        };
        const fields = {
            sid: 'xiaomiio',
            hash,
            callback: 'https://sts.api.io.mi.com/sts',
            qs: '%3Fsid%3Dxiaomiio%26_json%3Dtrue',
            user: this.username,
            _sign: this._sign,
            _json: 'true',
        };
        const captchaCode =
            typeof this.captCode === 'string' && this.captCode && this.captCode !== 'true'
                ? String(this.captCode).trim()
                : null;
        if (captchaCode) {
            fields.captCode = captchaCode;
            const ick = this.getCookie('ick');
            this.logger.info(
                `CloudApi-Step 2: submitting captcha len=${captchaCode.length} ick=${ick ? 'yes' : 'NO'}`,
            );
            if (!ick) {
                this.logger.error(
                    'CloudApi-Login: missing ick cookie – captcha image session was not stored; request a new captcha',
                );
            }
        }
        try {
            // Exact token-extractor behavior: POST with fields as query params
            const response = await this.session.post(url, null, {
                headers,
                params: fields,
                maxRedirects: 0,
            });

            let data = this.parseJSON(response.data);
            // First challenge also returns code 87001 – only treat as "invalid" when we already sent a code
            if (data.code === 87001 && captchaCode) {
                this.logger.warn('CloudApi-Login: captcha rejected (87001) – code wrong or ick cookie mismatch');
            }
            if (data.captchaUrl) {
                return await this.buildCaptchaChallenge(
                    data.captchaUrl,
                    captchaCode ? 'invalid or expired captcha' : null,
                );
            }

            if (data.ssecurity && String(data.ssecurity).length > 4) {
                this.ssecurity = data.ssecurity;
                this.location = data.location;
                this.userId = data.userId;
                this.captCode = false;
                return { ok: true };
            } else if (data.notificationUrl) {
                return await this.startTwoFactor(data.notificationUrl);
            }
            this.logger.debug(`CloudApi-Step 2 unexpected response: ${JSON.stringify(data)}`);
        } catch (err) {
            // @ts-expect-error err.message not defined
            this.logger.error('CloudApi-Login Step 2 failed:', err.message);
            // @ts-expect-error err.message not defined
            return { err: err.message };
        }
        return { err: 'could not get securityToken' };
    }

    /**
     * @param {string} captchaUrl
     * @param {string|null} reason
     */
    async buildCaptchaChallenge(captchaUrl, reason) {
        if (captchaUrl.indexOf('/') === 0) {
            captchaUrl = `https://account.xiaomi.com${captchaUrl}`;
        }
        let captchaDataUrl = null;
        try {
            const captchaResp = await this.session.get(captchaUrl, {
                headers: {
                    'User-Agent': this.agent,
                },
                responseType: 'arraybuffer',
            });
            const ick = this.getCookie('ick');
            this.logger.info(`CloudApi-Captcha downloaded, ick cookie=${ick ? 'yes' : 'NO'}`);
            const ctype = captchaResp.headers['content-type'] || 'image/jpeg';
            const b64 = Buffer.from(captchaResp.data).toString('base64');
            captchaDataUrl = `data:${ctype};base64,${b64}`;
        } catch (captchaErr) {
            // @ts-expect-error err.message
            this.logger.warn(`CloudApi-Captcha download failed: ${captchaErr.message}`);
        }
        this.pendingCaptcha = true;
        this.logger.info(
            `CloudApi-Login requires captcha${reason ? ` (${reason})` : ''} – enter code in adapter settings and click get devices again`,
        );
        return {
            err: reason ? `Please resolve captcha (${reason})` : 'Please resolve captcha',
            captchaUrl: captchaDataUrl || captchaUrl,
            pendingCaptcha: true,
        };
    }

    /**
     * @param {string} captCode
     */
    async continueWithCaptcha(captCode) {
        if (!captCode || typeof captCode !== 'string') {
            return { err: 'captcha code missing' };
        }
        if (!this._sign) {
            const step1 = await this.loginStep1();
            if (step1.err) {
                return step1;
            }
        }
        this.captCode = captCode.trim();
        this.logger.info('CloudApi-Login continuing with captcha on existing cookie jar');
        let result = await this.loginStep2();
        // captcha OK may directly yield ssecurity, or may require 2FA next
        if (result && result.pending2FA) {
            return result;
        }
        if (!result.err) {
            result = await this.loginStep3();
            if (!result.err) {
                this.pendingCaptcha = false;
                this.logger.info('CloudApi-Login erfolgreich (after captcha)!');
                return { ok: true, session: this.exportSession() };
            }
        }
        return result;
    }

    /**
     * Start Xiaomi identity 2FA after password/captcha succeeded.
     * Sends an email/SMS ticket and waits for Admin to supply the code.
     *
     * @param {string} notificationUrl
     */
    async startTwoFactor(notificationUrl) {
        const headers = {
            'User-Agent': this.agent,
            'Content-Type': 'application/x-www-form-urlencoded',
        };
        try {
            const urlObj = new URL(notificationUrl);
            const context = urlObj.searchParams.get('context');
            if (!context) {
                return { err: '2FA notificationUrl missing context' };
            }

            this.logger.info('CloudApi-2FA: opening identity authStart');
            await this.session.get(notificationUrl, { headers, maxRedirects: 5 });

            this.logger.debug('CloudApi-2FA: GET /identity/list');
            const listResp = await this.session.get('https://account.xiaomi.com/identity/list', {
                headers,
                params: {
                    sid: 'xiaomiio',
                    context,
                    _locale: 'de_DE',
                },
            });
            const listJson = this.parseJSON(listResp.data);
            // flag: 8 = email, 4 = phone (Xiaomi identity)
            let flag = listJson && listJson.flag != null ? String(listJson.flag) : '8';
            if (flag !== '4' && flag !== '8') {
                flag = '8';
            }
            const method = flag === '4' ? 'Phone' : 'Email';

            const sendParams = {
                _dc: String(Date.now()),
                sid: 'xiaomiio',
                context,
                mask: '0',
                _locale: 'de_DE',
            };
            const sendData = {
                retry: '0',
                icode: '',
                _json: 'true',
                ick: this.getCookie('ick') || '',
            };
            const sendUrl = `https://account.xiaomi.com/identity/auth/send${method}Ticket`;
            this.logger.info(`CloudApi-2FA: requesting ${method} ticket`);
            const sendResp = await this.session.post(sendUrl, qs.stringify(sendData), {
                headers,
                params: sendParams,
            });
            const sendJson = this.parseJSON(sendResp.data);
            if (sendJson && sendJson.captchaUrl) {
                // rare: another captcha inside 2FA send
                return await this.buildCaptchaChallenge(sendJson.captchaUrl, '2FA captcha required');
            }
            if (sendJson && sendJson.code && Number(sendJson.code) !== 0) {
                this.logger.warn(`CloudApi-2FA sendTicket response: ${JSON.stringify(sendJson)}`);
            }

            this.pendingCaptcha = false;
            this.pending2FA = true;
            this.twoFactor = { context, flag, method };
            const hint =
                (sendJson && (sendJson.maskedEmailAddress || sendJson.maskedEmail || sendJson.maskedPhoneNumber || sendJson.maskedPhone)) ||
                (method === 'Email' ? 'your email' : 'your phone');

            this.logger.info(
                `CloudApi-2FA: code sent via ${method} (${hint}). Enter the code in adapter settings and click get devices again.`,
            );
            return {
                err: `Two factor authentication required – enter the ${method} code`,
                pending2FA: true,
                twoFactorMethod: method,
                twoFactorHint: hint,
            };
        } catch (err) {
            // @ts-expect-error message
            this.logger.error(`CloudApi-2FA start failed: ${err.message}`);
            // @ts-expect-error message
            return { err: `2FA start failed: ${err.message}`, notificationUrl };
        }
    }

    /**
     * Complete 2FA with the email/SMS ticket code from Admin.
     *
     * @param {string} ticket
     */
    async continueWith2FA(ticket) {
        if (!this.pending2FA || !this.twoFactor) {
            return { err: 'no pending 2FA session – start login again' };
        }
        const code = String(ticket || '').trim();
        if (!code) {
            return { err: '2FA code missing' };
        }

        const headers = {
            'User-Agent': this.agent,
            'Content-Type': 'application/x-www-form-urlencoded',
        };
        const { context, flag, method } = this.twoFactor;
        const verifyParams = {
            _flag: flag,
            _json: 'true',
            sid: 'xiaomiio',
            context,
            mask: '0',
            _locale: 'de_DE',
        };
        const verifyData = {
            _flag: flag,
            ticket: code,
            trust: 'false',
            _json: 'true',
            ick: this.getCookie('ick') || '',
        };
        const verifyUrl = `https://account.xiaomi.com/identity/auth/verify${method}`;

        try {
            this.logger.info(`CloudApi-2FA: verifying ${method} ticket`);
            const verifyResp = await this.session.post(verifyUrl, qs.stringify(verifyData), {
                headers,
                params: verifyParams,
                maxRedirects: 0,
                validateStatus: status => status >= 200 && status < 400,
            });

            let finishLoc = null;
            try {
                const jr = this.parseJSON(verifyResp.data);
                finishLoc = jr && jr.location;
            } catch {
                // ignore
            }
            if (!finishLoc) {
                finishLoc = verifyResp.headers.location || verifyResp.headers.Location;
            }
            if (!finishLoc && typeof verifyResp.data === 'string') {
                const m = verifyResp.data.match(/https:\/\/account\.xiaomi\.com\/identity\/result\/check[^"'\s]+/);
                if (m) {
                    finishLoc = m[0];
                }
            }
            if (!finishLoc) {
                // fallback result/check
                const r0 = await this.session.get('https://account.xiaomi.com/identity/result/check', {
                    headers,
                    params: { sid: 'xiaomiio', context, _locale: 'de_DE' },
                    maxRedirects: 0,
                    validateStatus: status => status >= 200 && status < 400,
                });
                finishLoc = r0.headers.location || r0.headers.Location || null;
            }
            if (!finishLoc) {
                return { err: '2FA verify failed – no finish location (wrong code?)' };
            }

            // Hop through identity/result/check if needed
            let endUrl = finishLoc;
            if (String(finishLoc).includes('identity/result/check')) {
                const hop = await this.session.get(finishLoc, {
                    headers,
                    maxRedirects: 0,
                    validateStatus: status => status >= 200 && status < 400,
                });
                endUrl = hop.headers.location || hop.headers.Location;
                if (!endUrl) {
                    return { err: '2FA: missing Auth2/end redirect' };
                }
            }

            // Auth2/end – ssecurity is in extension-pragma header
            let endResp = await this.session.get(endUrl, {
                headers,
                maxRedirects: 0,
                validateStatus: status => status >= 200 && status < 400,
            });
            if (
                endResp.status === 200 &&
                typeof endResp.data === 'string' &&
                endResp.data.includes('Xiaomi Account - Tips')
            ) {
                endResp = await this.session.get(endUrl, {
                    headers,
                    maxRedirects: 0,
                    validateStatus: status => status >= 200 && status < 400,
                });
            }

            const extPrag = endResp.headers['extension-pragma'] || endResp.headers['Extension-Pragma'];
            if (extPrag) {
                try {
                    const ep = typeof extPrag === 'string' ? JSON.parse(extPrag) : extPrag;
                    if (ep && ep.ssecurity) {
                        this.ssecurity = ep.ssecurity;
                    }
                } catch (e) {
                    this.logger.debug(`CloudApi-2FA extension-pragma parse failed: ${e.message}`);
                }
            }
            if (!this.ssecurity) {
                return { err: '2FA: extension-pragma missing ssecurity' };
            }

            let stsUrl = endResp.headers.location || endResp.headers.Location;
            if (!stsUrl && typeof endResp.data === 'string') {
                const idx = endResp.data.indexOf('https://sts.api.io.mi.com/sts');
                if (idx !== -1) {
                    let end = endResp.data.indexOf('"', idx);
                    if (end === -1) {
                        end = idx + 400;
                    }
                    stsUrl = endResp.data.slice(idx, end);
                }
            }
            if (!stsUrl) {
                return { err: '2FA: STS redirect missing' };
            }

            const stsResp = await this.session.get(stsUrl, {
                headers,
                maxRedirects: 5,
                validateStatus: status => status >= 200 && status < 400,
            });
            this.serviceToken =
                this.getCookie('serviceToken') ||
                this.extractServiceTokenFromHeaders(stsResp.headers['set-cookie']);
            this.userId = this.userId || this.getCookie('userId');

            if (!this.serviceToken) {
                return { err: '2FA: serviceToken cookie missing after STS' };
            }

            this.pending2FA = false;
            this.twoFactor = null;
            this.pendingCaptcha = false;
            this.logger.info('CloudApi-Login erfolgreich (after 2FA)!');
            return { ok: true, session: this.exportSession() };
        } catch (err) {
            // @ts-expect-error message
            this.logger.error(`CloudApi-2FA verify failed: ${err.message}`);
            // @ts-expect-error message
            return { err: `2FA verify failed: ${err.message}` };
        }
    }

    /**
     * @param {string|string[]|undefined} setCookie
     */
    extractServiceTokenFromHeaders(setCookie) {
        if (!setCookie) {
            return null;
        }
        const list = Array.isArray(setCookie) ? setCookie : [setCookie];
        const hit = list.find(c => String(c).includes('serviceToken='));
        return hit ? String(hit).split('serviceToken=')[1].split(';')[0] : null;
    }

    async loginStep3() {
        this.logger.debug('CloudApi-Step 3: Fetching service token');
        const headers = {
            'User-Agent': this.agent,
            'Content-Type': 'application/x-www-form-urlencoded',
        };
        try {
            const response = await this.session.get(this.location, { headers });
            if (response.status === 200) {
                this.serviceToken = this.getCookie('serviceToken');
                if (this.serviceToken) {
                    return { ok: true };
                }
                // fallback: parse set-cookie header if jar missed it
                const setCookie = response.headers['set-cookie'] || [];
                const list = Array.isArray(setCookie) ? setCookie : [setCookie];
                const hit = list.find(c => String(c).includes('serviceToken='));
                if (hit) {
                    this.serviceToken = String(hit).split('serviceToken=')[1].split(';')[0];
                    if (this.serviceToken) {
                        return { ok: true };
                    }
                }
                throw new Error('serviceToken not found');
            }
        } catch (err) {
            // @ts-expect-error err.message not defined
            this.logger.error('CloudApi-Login Step 3 failed:', err.message);
            // @ts-expect-error err.message not defined
            return { err: err.message };
        }
        return { err: 'could not get serviceToken' };
    }

    async refreshToken() {
        this._sign = null;
        this.captCode = false;
        this.ssecurity = null;
        this.serviceToken = null;
        this.userId = null;
        this.pendingCaptcha = false;
        this.pending2FA = false;
        this.twoFactor = null;
        this.jar = new CookieJar();
        this.session = wrapper(
            axios.create({
                jar: this.jar,
                withCredentials: true,
                maxRedirects: 0,
                validateStatus: status => status >= 200 && status < 400,
            }),
        );
        this.primeJar();
        return this.login();
    }

    async login() {
        if (this.loggedIn()) {
            return { ok: true };
        }
        this.logger.debug('CloudApi-Login gestartet…');
        let result = await this.loginStep1();
        if (!result.err) {
            // step1 may already have completed login via existing cookies
            if (this.ssecurity && this.userId && this.location && !this.serviceToken) {
                result = await this.loginStep3();
                if (!result.err) {
                    return { ok: true, session: this.exportSession() };
                }
                return result;
            }
            if (this.loggedIn()) {
                return { ok: true, session: this.exportSession() };
            }
            result = await this.loginStep2();
            if (!result.err) {
                result = await this.loginStep3();
                if (!result.err) {
                    this.logger.debug('CloudApi-Login erfolgreich!');
                    return { ok: true, session: this.exportSession() };
                }
                return result;
            }
            return result;
        }
        return result;
    }

    parseJSON(raw) {
        try {
            if (typeof raw === 'string') {
                return JSON.parse(raw.replace('&&&START&&&', ''));
            }
            if (Buffer.isBuffer(raw)) {
                return JSON.parse(raw.toString('utf8').replace('&&&START&&&', ''));
            }
            return raw;
        } catch (err) {
            // @ts-expect-error err.message not defined
            this.logger.error('CloudApi-JSON Parse Error:', err.message);
            return {};
        }
    }

    async getHomes(country) {
        const url = `${this.getApiUrl(country)}/v2/homeroom/gethome`;
        const data = JSON.stringify({ fg: true, fetch_share: true, fetch_share_dev: true, limit: 300, app_ver: 7 });
        return await this.executeEncryptedApiCall(url, { data }).then(json => {
            this.homeIds = [];
            if (json && json.result && json.result.homelist) {
                for (let h of json.result.homelist) {
                    this.homeIds.push(h.id);
                }
            }
        });
    }

    async getDevices(country, homeIds) {
        if (!homeIds) {
            if (!this.homeIds) {
                await this.getHomes(country);
            }
            homeIds = this.homeIds?.slice();
        } else if (typeof homeIds != 'object') {
            homeIds = [homeIds];
        }
        const url = `${this.getApiUrl(country)}/v2/home/home_device_list`;
        const params = {
            home_owner: this.userId,
            limit: 200,
            get_split_device: true,
            support_smart_home: true,
        };
        const devices = {};
        for (let homeId of homeIds) {
            params.home_id = homeId;
            const data = JSON.stringify(params);
            devices[homeId] = await this.executeEncryptedApiCall(url, { data });
        }
        return devices;
    }

    async executeEncryptedApiCall(url, params) {
        const headers = {
            'Accept-Encoding': 'identity',
            'User-Agent': this.agent,
            'Content-Type': 'application/x-www-form-urlencoded',
            'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
            'MIOT-ENCRYPT-ALGORITHM': 'ENCRYPT-RC4',
            Cookie: `userId=${this.userId}; yetAnotherServiceToken=${this.serviceToken}; serviceToken=${this.serviceToken}; locale=de_DE; timezone=GMT%2B02%3A00; is_daylight=1; dst_offset=3600000; channel=MI_APP_STORE; ${this.commonCookies}`,
        };
        const millis = Date.now();
        const nonce = this.generateNonce(millis);
        const signedNonce = this.signedNonce(nonce, this.ssecurity);
        const rc4 = new XiaomiRC4Cipher(signedNonce);
        this.logger.debug(`CloudApi-call: ${url} with ${JSON.stringify(params)}`);
        const fields = this.generateEncryptedParams(rc4, url, 'POST', nonce, params, this.ssecurity);
        const query = qs.stringify(fields, { encode: true });
        try {
            const response = await axios.post(`${url}?${query}`, null, {
                headers,
                maxRedirects: 0,
            });

            if (response.status === 200) {
                const decrypted = new XiaomiRC4Cipher(signedNonce).decrypt(response.data);
                this.logger.debug(`CloudApi-get ${decrypted}`);
                return JSON.parse(decrypted);
            }
        } catch (err) {
            //@ts-expect-error undefined err.message
            this.logger.error(`CloudApi: executeEncryptedApiCall Error: ${err.message}`);
            //@ts-expect-error undefined err.message
            throw err.message;
        }
        return null;
    }

    generateAgent() {
        let agentId = Array.from({ length: 13 }, () => String.fromCharCode(Math.floor(Math.random() * 5) + 65)).join(
            '',
        );
        let randomText = Array.from({ length: 18 }, () =>
            String.fromCharCode(Math.floor(Math.random() * 26) + 97),
        ).join('');
        return `${randomText}-${agentId} APP/com.xiaomi.mihome APPV/10.5.201`;
    }

    generateDeviceId() {
        return Array.from({ length: 6 }, () => String.fromCharCode(Math.floor(Math.random() * 26) + 97)).join('');
    }

    getApiUrl(country) {
        return `https://${country === 'cn' || country === '-' ? '' : `${country}.`}api.io.mi.com/app`;
    }

    signedNonce(nonce, ssecurity) {
        const hash = crypto
            .createHash('sha256')
            .update(Buffer.concat([Buffer.from(ssecurity, 'base64'), Buffer.from(nonce, 'base64')]))
            .digest();
        return Buffer.from(hash).toString('base64');
    }

    generateNonce(millis) {
        const randomBytes = crypto.randomBytes(8);
        const timeBytes = Buffer.alloc(4);
        timeBytes.writeUInt32BE(Math.floor(millis / 60000), 0);
        return Buffer.concat([randomBytes, timeBytes]).toString('base64');
    }

    generateEncSignature(url, method, signedNonce, params) {
        const paramsArray = [];
        paramsArray.push('POST');
        paramsArray.push(`/${url.split('/app/')[1]}`);
        for (const key in params) {
            paramsArray.push(`${key}=${params[key]}`);
        }
        paramsArray.push(signedNonce);
        const shasum = crypto.createHash('sha1');
        return shasum.update(paramsArray.join('&'), 'utf8').digest('base64');
    }

    generateEncryptedParams(rc4, url, method, nonce, params, ssecurity) {
        params['rc4_hash__'] = this.generateEncSignature(url, method, rc4.passwordB64, params);
        for (const [k, v] of Object.entries(params)) {
            params[k] = rc4.encrypt(v);
        }
        params['signature'] = this.generateEncSignature(url, method, rc4.passwordB64, params);
        params['ssecurity'] = ssecurity;
        params['_nonce'] = nonce;

        return params;
    }
}

class XiaomiRC4Cipher {
    constructor(passwordB64) {
        this.passwordB64 = passwordB64;
        this.key = Buffer.from(passwordB64, 'base64');
        this.S = new Uint8Array(256);
        for (let i = 0; i < 256; i++) {
            this.S[i] = i;
        }

        let j = 0;
        for (let i = 0; i < 256; i++) {
            j = (j + this.S[i] + this.key[i % this.key.length]) % 256;
            [this.S[i], this.S[j]] = [this.S[j], this.S[i]];
        }

        this.i = 0;
        this.j = 0;
        for (let drop = 0; drop < 1024; drop++) {
            this.generateKeystreamByte();
        }
    }

    generateKeystreamByte() {
        this.i = (this.i + 1) % 256;
        this.j = (this.j + this.S[this.i]) % 256;
        [this.S[this.i], this.S[this.j]] = [this.S[this.j], this.S[this.i]];
        return this.S[(this.S[this.i] + this.S[this.j]) % 256];
    }

    encrypt(plainText) {
        const input = Buffer.from(String(plainText), 'utf8');
        const output = Buffer.alloc(input.length);
        for (let k = 0; k < input.length; k++) {
            const rnd = this.generateKeystreamByte();
            output[k] = input[k] ^ rnd;
        }
        return output.toString('base64');
    }

    decrypt(cipherTextB64) {
        const input = Buffer.from(cipherTextB64, 'base64');
        const output = Buffer.alloc(input.length);
        for (let k = 0; k < input.length; k++) {
            const rnd = this.generateKeystreamByte();
            output[k] = input[k] ^ rnd;
        }
        return output.toString('utf8');
    }
}

module.exports = XiaomiCloudConnector;
