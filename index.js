require("dotenv").config();

const Web3 = require("web3");
const DSA = require("dsa-sdk");
const axios = require("axios");
const Telegraf = require("telegraf"); // import telegram lib
const Markup = require("telegraf/markup");
const Stage = require("telegraf/stage");
const session = require("telegraf/session");
const WizardScene = require("telegraf/scenes/wizard");
const { enter, leave } = Stage

const web3 = new Web3(
  new Web3.providers.HttpProvider(process.env.ETH_NODE_URL)
);
const dsa = new DSA({
  web3: web3,
  mode: "node",
  privateKey: process.env.PRIVATE_KEY,
});
setupKovan();

let vault = 2096;
let alertLevel = 200;
let lastMsgSentTime = 0;

const address = process.env.ADDRESS;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID;

const bot = new Telegraf(BOT_TOKEN);
// display Welcome text when we start bot
bot.start((ctx) =>
  bot.telegram.sendMessage(ctx.chat.id,
    `Welcome to CDPAlerter!\n
    ${ctx.from.first_name}, please Setup Alerts for your CDP Vault:\n
    /setupalert`,
    Markup.inlineKeyboard([
      Markup.callbackButton("Setup Alert", "SETUP_ALERT"),
    ]).extra()
  )
);

// listen and handle when user type 'A' text
bot.hears("A", (ctx) => {
  // console.log(ctx.chat.id);
  // userIdToVaultMapping[ctx.chat.id] = 123321
  // console.log(userIdToVaultMapping)
  bot.telegram.sendMessage(ctx.chat.id,
    `Welcome to CDPAlerter!\n${ctx.from.first_name}, please enter your Vault Number to track using the following command:\n/setupalert`
  );
});

const initializeVaultData = new WizardScene(
  "initialize",
  (ctx) => {
    bot.telegram.sendMessage(ctx.chat.id, "Let's Setup Alerts for your Vault!\nEnter your Main address.");
    return ctx.wizard.next();
  },
  (ctx) => {
    /*
     * ctx.wizard.state is the state management object which is persistent
     * throughout the wizard
     * we pass to it the previous user reply (supposed to be the source Currency )
     * which is retrieved through `ctx.message.text`
     */
    ctx.wizard.state.dsaAddr = ctx.message.text;
    let msg='Choose from the following Vault IDs:\n'
    let count=1
    dsa.getAccounts(address)
    .then(accounts => dsa.setInstance(accounts[0].id))
    .then(() => dsa.maker.getVaults(dsa.instance.address))
    .then(vaults => {
      for(var key in vaults){
        msg += `${count})  ${key}\n`
        count++
      }
      bot.telegram.sendMessage(ctx.chat.id, 
        msg
      );
      // Go to the following scene
      return ctx.wizard.next();
    })
  },
  (ctx) => {
    /*
     * ctx.wizard.state is the state management object which is persistent
     * throughout the wizard
     * we pass to it the previous user reply (supposed to be the source Currency )
     * which is retrieved through `ctx.message.text`
     */
    ctx.wizard.state.vaultNo = ctx.message.text;
    bot.telegram.sendMessage(ctx.chat.id, 
      `Got it, enter the CDP Ratio to receive Alert for.\n[Eg: 200 for 200% limit]`
    );
    // Go to the following scene
    return ctx.wizard.next();
  },
  (ctx) => {
    const cdpLimit = (ctx.wizard.state.cdpLimit = ctx.message.text);
    const vaultNo = ctx.wizard.state.vaultNo;

    console.log("CDP limit:", cdpLimit, "VaultNo:", vaultNo);
    alertLevel=cdpLimit

    bot.telegram.sendMessage(ctx.chat.id, 
      `Done! You would get an alert for your Vault No. ${vaultNo} when the CDP goes below ${cdpLimit}%.`
    );
    return ctx.scene.leave();
  }
);
// Scene registration
const stage = new Stage([initializeVaultData], { ttl: 300 });
bot.use(session());
bot.use(stage.middleware());

bot.command("setupalert", enter("initialize"));
bot.action("SETUP_ALERT", enter("initialize"));
bot.startPolling(); // start

console.log("Bot Started");


dsa.getAccounts(address)
  .then(accounts => dsa.setInstance(accounts[0].id))
  .then(() => dsa.maker.getVaults(dsa.instance.address))
  .then(console.log)

async function checkCDP(vault) {
  dsa.maker.getVaults(dsa.instance.address)
    .then(vaults => {
      var cdp = (100/(vaults[vault].status))
      var now = Math.round(new Date().getTime() / 1000);
      if (cdp <= alertLevel && now - lastMsgSentTime >= 60 * 60) {
        bot.telegram.sendMessage(CHAT_ID,
          `🚨🚨🚨 CDP Ratio is in Danger Zone! 🚨🚨🚨\nAct Now before it's too late!\nCDP Ratio for Vault No. ${vault} is ${cdp.toFixed(
            2
          )}.`
        );
        axios.get(encodeURI(uri)).then((resp) => {
          //console.log(resp.data);
          lastMsgSentTime = now;
          console.log("Msg sent");
        });
      }
      // extreme critical region
      if(cdp <= 160 && cdp >= 150){
        preventLiquidate(vaults[vault])
      }
    })
}

async function preventLiquidate(vaultInfo) {
  let spells = dsa.Spell();
  var ethLockedinUSD = vaultInfo.col * vaultInfo.price
  var daiBorrowed = vaultInfo.debt

  var daiFlashBorrowAmt = daiBorrowed/3;
  var ethWithdrawAmt = daiFlashBorrowAmt/(vaultInfo.price)

  daiFlashBorrowAmt = dsa.tokens.fromDecimal(daiFlashBorrowAmt, "dai")
  ethWithdrawAmt = dsa.tokens.fromDecimal(ethWithdrawAmt, "eth")
  let buyAmount = await dsa.oasis.getBuyAmount("DAI", "ETH", ethWithdrawAmt, 0.1);
  spells.add({
    connector: "instapool",
    method: "flashBorrow",
    args: [dsa.tokens.info.dai.address, daiFlashBorrowAmt, 0, 0]
  });
  spells.add({
    connector: "maker",
    method: "payback",
    args: [vault, daiFlashBorrowAmt, 0, 0]
  });
  spells.add({
    connector: "maker",
    method: "withdraw",
    args: [vault, ethWithdrawAmt, 0, 0]
  });
  // spells.add({
  //   connector: "kyber",
  //   method: "sell",
  //   args: [ ethWithdrawAmt, unitAmt, 0, 0]
  // });
  spells.add({
    connector: "oasis",
    method: "sell",
    args: [dsa.tokens.info.dai.address, "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", ethWithdrawAmt, buyAmount.unitAmt, 0, 0] // setting USDC amount with id 423
  });
  spells.add({
    connector: "instapool",
    method: "flashPayback",
    args: [dsa.tokens.info.dai.address, 0, 0]
  });
  dsa.cast(spells).then(console.log)
}

setInterval(() => checkCDP(vault), 3000);


function setupKovan() {
  dsa.address.read.core = "0x2Ec9378446e3873e3aFE9CAEe2056b318712B3db";
  dsa.address.read.compound = "0x01D17A809A1D5D60d117b048DAeE6d8a1d26E326";
  dsa.address.read.maker = "0x04c99f93A753fe37A72690625e1cf89BA84cA7a9";

  dsa.tokens.info.ceth.address = "0xf92FbE0D3C0dcDAE407923b2Ac17eC223b1084E4";
  dsa.tokens.info.cdai.address = "0xe7bc397dbd069fc7d0109c0636d06888bb50668c";
  dsa.tokens.info.cusdc.address = "0xcfc9bb230f00bffdb560fce2428b4e05f3442e35";
  dsa.tokens.info.cusdt.address = "0x3f0a0ea2f86bae6362cf9799b523ba06647da018";
  dsa.tokens.info.cwbtc.address = "0x3659728876efb2780f498ce829c5b076e496e0e3";
  dsa.tokens.info.czrx.address = "0xc014dc10a57ac78350c5fddb26bb66f1cb0960a0";
  dsa.tokens.info.crep.address = "0xfd874be7e6733bdc6dca9c7cdd97c225ec235d39";
  dsa.tokens.info.cbat.address = "0xd5ff020f970462816fdd31a603cb7d120e48376e";
  dsa.tokens.info.dai.address = "0xC4375B7De8af5a38a93548eb8453a498222C4fF2"
}