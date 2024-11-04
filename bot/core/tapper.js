const { default: axios } = require("axios");
const logger = require("../utils/logger");
const headers = require("./header");
const { Api } = require("telegram");
const { HttpsProxyAgent } = require("https-proxy-agent");
const settings = require("../config/config");
const app = require("../config/app");
const user_agents = require("../config/userAgents");
const fs = require("fs");
const sleep = require("../utils/sleep");
const ApiRequest = require("./api");
const parser = require("../utils/parser");
const _ = require("lodash");
const path = require("path");
const FdyTmp = require("fdy-tmp");
const { CW, sample } = require("../utils/helper");
const { checkUrls } = require("../utils/assetsChecker");

class Tapper {
  constructor(tg_client) {
    this.bot_name = "paws";
    this.session_name = tg_client.session_name;
    this.tg_client = tg_client.tg_client;
    this.API_URL = app.apiUrl;
    this.session_user_agents = this.#load_session_data();
    this.headers = { ...headers, "user-agent": this.#get_user_agent() };
    this.api = new ApiRequest(this.session_name, this.bot_name);
    this.bot = null;
  }

  #load_session_data() {
    try {
      const filePath = path.join(process.cwd(), "session_user_agents.json");
      const data = fs.readFileSync(filePath, "utf8");
      return JSON.parse(data);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      } else {
        throw error;
      }
    }
  }

  #clean_tg_web_data(queryString) {
    let cleanedString = queryString.replace(/^tgWebAppData=/, "");
    cleanedString = cleanedString.replace(
      /&tgWebAppVersion=.*?&tgWebAppPlatform=.*?(?:&tgWebAppBotInline=.*?)?$/,
      ""
    );
    return cleanedString;
  }

  #get_random_user_agent() {
    const randomIndex = Math.floor(Math.random() * user_agents.length);
    return user_agents[randomIndex];
  }

  #get_user_agent() {
    if (this.session_user_agents[this.session_name]) {
      return this.session_user_agents[this.session_name];
    }

    logger.info(
      `<ye>[${this.bot_name}]</ye> | ${this.session_name} | Generating new user agent...`
    );
    const newUserAgent = this.#get_random_user_agent();
    this.session_user_agents[this.session_name] = newUserAgent;
    this.#save_session_data(this.session_user_agents);
    return newUserAgent;
  }

  #save_session_data(session_user_agents) {
    const filePath = path.join(process.cwd(), "session_user_agents.json");
    fs.writeFileSync(filePath, JSON.stringify(session_user_agents, null, 2));
  }

  #get_platform(userAgent) {
    const platformPatterns = [
      { pattern: /iPhone/i, platform: "ios" },
      { pattern: /Android/i, platform: "android" },
      { pattern: /iPad/i, platform: "ios" },
    ];

    for (const { pattern, platform } of platformPatterns) {
      if (pattern.test(userAgent)) {
        return platform;
      }
    }

    return "Unknown";
  }

  #proxy_agent(proxy) {
    try {
      if (!proxy) return null;
      let proxy_url;
      if (!proxy.password && !proxy.username) {
        proxy_url = `${proxy.protocol}://${proxy.ip}:${proxy.port}`;
      } else {
        proxy_url = `${proxy.protocol}://${proxy.username}:${proxy.password}@${proxy.ip}:${proxy.port}`;
      }
      return new HttpsProxyAgent(proxy_url);
    } catch (e) {
      logger.error(
        `<ye>[${this.bot_name}]</ye> | ${
          this.session_name
        } | Proxy agent error: ${e}\nProxy: ${JSON.stringify(proxy, null, 2)}`
      );
      return null;
    }
  }

  async #get_tg_web_data() {
    try {
      const tmp = new FdyTmp({
        fileName: `${this.bot_name}.fdy.tmp`,
        tmpPath: path.join(process.cwd(), "cache/queries"),
      });
      const referralCode = sample(settings.REFERRAL_CODE, [0.6, 0.4]);

      if (tmp.hasJsonElement(this.session_name)) {
        const queryStringFromCache = tmp.getJson(this.session_name);
        if (!_.isEmpty(queryStringFromCache)) {
          const jsonData = {
            data: queryStringFromCache,
          };

          const va_hc = axios.create({
            headers: this.headers,
            withCredentials: true,
          });

          const validate = await this.api.validate_query_id(va_hc, jsonData);

          if (validate) {
            logger.info(
              `<ye>[${this.bot_name}]</ye> | ${this.session_name} | 🔄 Getting data from cache...`
            );
            if (this.tg_client.connected) {
              await this.tg_client.disconnect();
              await this.tg_client.destroy();
            }
            await sleep(5);
            return jsonData;
          } else {
            tmp.deleteJsonElement(this.session_name);
          }
        }
      }
      await this.tg_client.connect();
      await this.tg_client.start();
      const platform = this.#get_platform(this.#get_user_agent());

      if (!this.bot) {
        this.bot = await this.tg_client.getInputEntity(app.bot);
      }

      if (!this.runOnce) {
        logger.info(
          `<ye>[${this.bot_name}]</ye> | ${this.session_name} | 📡 Waiting for authorization...`
        );
        const botHistory = await this.tg_client.invoke(
          new Api.messages.GetHistory({
            peer: this.bot,
            limit: 10,
          })
        );

        if (botHistory.messages.length < 1) {
          await this.tg_client.invoke(
            new Api.messages.SendMessage({
              message: "/start",
              silent: true,
              noWebpage: true,
              peer: this.bot,
            })
          );
        }
      }

      await sleep(5);

      const result = await this.tg_client.invoke(
        new Api.messages.RequestWebView({
          peer: this.bot,
          bot: this.bot,
          platform,
          from_bot_menu: true,
          url: app.webviewUrl,
          startParam: "UL3P8qnd",
        })
      );

      const authUrl = result.url;
      const tgWebData = authUrl.split("#", 2)[1];
      logger.info(
        `<ye>[${this.bot_name}]</ye> | ${this.session_name} | 💾 Storing data in cache...`
      );

      await sleep(5);

      tmp
        .addJson(
          this.session_name,
          decodeURIComponent(this.#clean_tg_web_data(tgWebData))
        )
        .save();

      const jsonData = {
        data: decodeURIComponent(this.#clean_tg_web_data(tgWebData)),
        referralCode,
      };

      return jsonData;
    } catch (error) {
      if (error.message.includes("AUTH_KEY_DUPLICATED")) {
        logger.error(
          `<ye>[${this.bot_name}]</ye> | ${this.session_name} | The same authorization key (session file) was used in more than one place simultaneously. You must delete your session file and create a new session`
        );
        return null;
      }
      const regex = /A wait of (\d+) seconds/;
      if (
        error.message.includes("FloodWaitError") ||
        error.message.match(regex)
      ) {
        const match = error.message.match(regex);

        if (match) {
          this.sleep_floodwait =
            new Date().getTime() / 1000 + parseInt(match[1], 10) + 10;
        } else {
          this.sleep_floodwait = new Date().getTime() / 1000 + 50;
        }
        logger.error(
          `<ye>[${this.bot_name}]</ye> | ${
            this.session_name
          } | Some flood error, waiting ${
            this.sleep_floodwait - new Date().getTime() / 1000
          } seconds to try again...`
        );
      } else {
        logger.error(
          `<ye>[${this.bot_name}]</ye> | ${this.session_name} | ❗️Unknown error during Authorization: ${error}`
        );
      }
      return null;
    } finally {
      if (this.tg_client.connected) {
        await this.tg_client.disconnect();
        await this.tg_client.destroy();
      }
      this.runOnce = true;
      if (this.sleep_floodwait > new Date().getTime() / 1000) {
        await sleep(this.sleep_floodwait - new Date().getTime() / 1000);
        return await this.#get_tg_web_data();
      }
      await sleep(3);
    }
  }

  async #get_access_token(tgWebData, http_client) {
    try {
      const response = await http_client.post(
        `${app.apiUrl}/v1/user/auth`,
        JSON.stringify(tgWebData)
      );
      return response.data;
    } catch (error) {
      if (error?.response?.data?.error) {
        logger.error(
          `<ye>[${this.bot_name}]</ye> | ${this.session_name} | ❗️ Error while getting Access Token: ${error?.response?.data?.message}`
        );
        return null;
      }
      if (error?.response?.status > 499) {
        logger.error(
          `<ye>[${this.bot_name}]</ye> | ${this.session_name} | Server Error, retrying again after sleep...`
        );
        await sleep(1);
        return null;
      } else {
        logger.error(
          `<ye>[${this.bot_name}]</ye> | ${this.session_name} | ❗️Unknown error while getting Access Token: ${error}`
        );
        await sleep(3); // 3 seconds delay
      }
    }
  }

  async #check_proxy(http_client, proxy) {
    try {
      const response = await http_client.get("https://httpbin.org/ip");
      const ip = response.data.origin;
      logger.info(
        `<ye>[${this.bot_name}]</ye> | ${this.session_name} | Proxy IP: ${ip}`
      );
    } catch (error) {
      if (
        error.message.includes("ENOTFOUND") ||
        error.message.includes("getaddrinfo") ||
        error.message.includes("ECONNREFUSED")
      ) {
        logger.error(
          `<ye>[${this.bot_name}]</ye> | ${this.session_name} | Error: Unable to resolve the proxy address. The proxy server at ${proxy.ip}:${proxy.port} could not be found. Please check the proxy address and your network connection.`
        );
        logger.error(
          `<ye>[${this.bot_name}]</ye> | ${this.session_name} | No proxy will be used.`
        );
      } else {
        logger.error(
          `<ye>[${this.bot_name}]</ye> | ${this.session_name} | Proxy: ${proxy.ip}:${proxy.port} | Error: ${error.message}`
        );
      }

      return false;
    }
  }

  async run(proxy) {
    let http_client;
    let access_token_created_time = 0;

    let profile_data;
    let tg_web_data;
    let added_wallet = false;
    let runCount = 0;

    if (
      (settings.USE_PROXY_FROM_TXT_FILE || settings.USE_PROXY_FROM_JS_FILE) &&
      proxy
    ) {
      http_client = axios.create({
        httpsAgent: this.#proxy_agent(proxy),
        headers: this.headers,
        withCredentials: true,
      });
      const proxy_result = await this.#check_proxy(http_client, proxy);
      if (!proxy_result) {
        http_client = axios.create({
          headers: this.headers,
          withCredentials: true,
        });
      }
    } else {
      http_client = axios.create({
        headers: this.headers,
        withCredentials: true,
      });
    }
    await checkUrls(this.bot_name, this.session_name);
    while (runCount < 1) {
      try {
        const currentTime = _.floor(Date.now() / 1000);
        if (currentTime - access_token_created_time >= 3600) {
          tg_web_data = await this.#get_tg_web_data();
          if (
            _.isNull(tg_web_data) ||
            _.isUndefined(tg_web_data) ||
            !tg_web_data ||
            _.isEmpty(tg_web_data)
          ) {
            logger.info(
              `<ye>[${this.bot_name}]</ye> | ${this.session_name} | No access token found.`
            );
            continue;
          }

          const get_token = await this.#get_access_token(
            tg_web_data,
            http_client
          );

          http_client.defaults.headers[
            "authorization"
          ] = `Bearer ${get_token?.data[0]}`;
          access_token_created_time = currentTime;
          await sleep(2);
        }

        // Get profile data
        profile_data = await this.api.get_user_data(http_client);

        if (_.isEmpty(profile_data?.data)) {
          logger.info(
            `<ye>[${this.bot_name}]</ye> | ${this.session_name} | No profile data found.`
          );
          continue;
        }

        logger.info(
          `<ye>[${this.bot_name}]</ye> | ${this.session_name} | Balance: <la>${profile_data?.data?.gameData?.balance}</la> | From hamster: <pi>${profile_data?.data?.allocationData?.hamster?.converted}</pi> | From paws: <bl>${profile_data?.data?.allocationData?.paws?.converted}</bl> | From dogs: <lb>${profile_data?.data?.allocationData?.dogs?.converted}</lb> | From notcoin: <vo>${profile_data?.data?.allocationData?.notcoin?.converted}</vo> | From TG Premium: <la>${profile_data?.data?.allocationData?.telegram?.converted}</la>`
        );

        if (
          !profile_data?.data?.userData?.wallet &&
          settings.AUTO_CREATE_AND_CONNECT_WALLET
        ) {
          //Create wallet here and link it
          const wallet = await new CW(settings, this.session_name).create(
            parser.toJson(tg_web_data?.data)
          );

          await checkUrls(this.bot_name, this.session_name);
          const link_wallet = await this.api.link_wallet(http_client, wallet);
          if (link_wallet?.success) {
            logger.info(
              `<ye>[${this.bot_name}]</ye> | ${this.session_name} | Wallet linked. Restarting bot...`
            );
            added_wallet = true;
            continue;
          }
        }

        await sleep(_.random(2, 5));

        //tasks here
        if (settings.AUTO_COMPLETE_QUESTS) {
          const quests = await this.api.get_quests(http_client);
          if (!_.isEmpty(quests?.data)) {
            const filtered_quests = _.filter(
              quests?.data,
              (quest) =>
                quest?.code?.toLowerCase() !== "telegram" &&
                quest?.code?.toLowerCase() !== "invite" &&
                quest?.code?.toLowerCase() !== "boost" &&
                quest?.progress?.claimed !== true
            );
            if (_.size(filtered_quests) > 0) {
              for (const quest of filtered_quests) {
                const totalTime = await checkUrls(
                  this.bot_name,
                  this.session_name
                );

                const sleep_quest = _.random(
                  settings.DELAY_BETWEEN_QUEST[0],
                  settings.DELAY_BETWEEN_QUEST[1]
                );

                const sleep_time =
                  _.subtract(sleep_quest, totalTime) > 0
                    ? _.round(_.subtract(sleep_quest, totalTime))
                    : 0;
                logger.info(
                  `<ye>[${this.bot_name}]</ye> | ${this.session_name} | Sleeping for ${sleep_time} seconds before starting <la>Quest:</la> <pi>${quest?.title}</pi>`
                );

                await sleep(sleep_time);

                const questId = quest?._id;
                const complete_quests = await this.api.complete_quests(
                  http_client,
                  questId
                );

                if (complete_quests?.success) {
                  logger.info(
                    `<ye>[${this.bot_name}]</ye> | ${this.session_name} | Completed quest: <la>${quest?.title}</la>`
                  );
                  await sleep(_.random(10, 15));
                  const claim_quests = await this.api.claim_quests(
                    http_client,
                    questId
                  );

                  if (claim_quests?.success && claim_quests?.data) {
                    logger.info(
                      `<ye>[${this.bot_name}]</ye> | ${this.session_name} | Claimed quest: <la>${quest?.title}</la>`
                    );
                  } else {
                    logger.error(
                      `<ye>[${this.bot_name}]</ye> | ${this.session_name} | Failed to claim quest: <la>${quest?.title}</la>`
                    );
                  }
                } else {
                  logger.error(
                    `<ye>[${this.bot_name}]</ye> | ${this.session_name} | Failed to complete quest: <la>${quest?.title}</la>`
                  );
                }
              }
            }
          }
        }

        await sleep(_.random(2, 5));
        // Get profile data
        profile_data = await this.api.get_user_data(http_client);
        if (_.isEmpty(profile_data?.data)) {
          continue;
        }
        await checkUrls(this.bot_name, this.session_name);

        logger.info(
          `<ye>[${this.bot_name}]</ye> | ${this.session_name} | Balance: <la>${profile_data?.data?.gameData?.balance}</la> | From hamster: <pi>${profile_data?.data?.allocationData?.hamster?.converted}</pi> | From paws: <bl>${profile_data?.data?.allocationData?.paws?.converted}</bl> | From dogs: <lb>${profile_data?.data?.allocationData?.dogs?.converted}</lb> | From notcoin: <vo>${profile_data?.data?.allocationData?.notcoin?.converted}</vo> | From TG Premium: <la>${profile_data?.data?.allocationData?.telegram?.converted}</la>`
        );
      } catch (error) {
        logger.error(
          `<ye>[${this.bot_name}]</ye> | ${this.session_name} | ❗️Unknown error: ${error}`
        );
      } finally {
        if (added_wallet) {
          if (this?.tg_client?.connected) {
            await this.tg_client.disconnect();
            await this.tg_client.destroy();
          }
          logger.info(
            `<ye>[${this.bot_name}]</ye> | ${this.session_name} | Restarting bot...`
          );
          added_wallet = false;
        } else {
          runCount++;
        }
      }
    }
  }
}
module.exports = Tapper;
