/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/* eslint-disable no-console */
// @ts-nocheck

import fs from 'fs';
import os from 'os';
import path from 'path';
import { program, Command } from 'commander';
import { runDriver, runServer, printApiJson, launchBrowserServer } from './driver';
import { showTraceViewer } from '../server/trace/viewer/traceViewer';
import * as playwright from '../';
import { BrowserContext } from '../client/browserContext';
import { Browser } from '../client/browser';
import { Page } from '../client/page';
import { BrowserType } from '../client/browserType';
import { BrowserContextOptions, LaunchOptions } from '../client/types';
import { spawn } from 'child_process';
import { registry, Executable } from '../utils/registry';
import { spawnAsync, getPlaywrightVersion } from '../utils/utils';
import { launchGridAgent } from '../grid/gridAgent';
import { GridServer, GridFactory } from '../grid/gridServer';

function suggestedBrowsersToInstall() {
  return registry.executables().filter(e => e.installType !== 'none' && e.type !== 'tool').map(e => e.name).join(', ');
}

function checkBrowsersToInstall(args: string[]): Executable[] {
  const faultyArguments: string[] = [];
  const executables: Executable[] = [];
  for (const arg of args) {
    const executable = registry.findExecutable(arg);
    if (!executable || executable.installType === 'none')
      faultyArguments.push(arg);
    else
      executables.push(executable);
  }
  if (faultyArguments.length) {
    console.log(`Invalid installation targets: ${faultyArguments.map(name => `'${name}'`).join(', ')}. Expecting one of: ${suggestedBrowsersToInstall()}`);
    process.exit(1);
  }
  return executables;
}

type Options = {
  browser: string;
  channel?: string;
  colorScheme?: string;
  device?: string;
  geolocation?: string;
  ignoreHttpsErrors?: boolean;
  lang?: string;
  loadStorage?: string;
  proxyServer?: string;
  proxyBypass?: string;
  saveStorage?: string;
  saveTrace?: string;
  timeout: string;
  timezone?: string;
  viewportSize?: string;
  userAgent?: string;
};

type CaptureOptions = {
  waitForSelector?: string;
  waitForTimeout?: string;
  fullPage: boolean;
};

async function launchContext(options: Options, headless: boolean, executablePath?: string): Promise<{ browser: Browser, browserName: string, launchOptions: LaunchOptions, contextOptions: BrowserContextOptions, context: BrowserContext }> {
  validateOptions(options);
  const browserType = lookupBrowserType(options);
  const launchOptions: LaunchOptions = { headless, executablePath };
  if (options.channel)
    launchOptions.channel = options.channel as any;

  const contextOptions: BrowserContextOptions =
    // Copy the device descriptor since we have to compare and modify the options.
    options.device ? { ...playwright.devices[options.device] } : {};

  // In headful mode, use host device scale factor for things to look nice.
  // In headless, keep things the way it works in Playwright by default.
  // Assume high-dpi on MacOS. TODO: this is not perfect.
  if (!headless)
    contextOptions.deviceScaleFactor = os.platform() === 'darwin' ? 2 : 1;

  // Work around the WebKit GTK scrolling issue.
  if (browserType.name() === 'webkit' && process.platform === 'linux') {
    delete contextOptions.hasTouch;
    delete contextOptions.isMobile;
  }

  if (contextOptions.isMobile && browserType.name() === 'firefox')
    contextOptions.isMobile = undefined;

  // Proxy

  if (options.proxyServer) {
    launchOptions.proxy = {
      server: options.proxyServer
    };
    if (options.proxyBypass)
      launchOptions.proxy.bypass = options.proxyBypass;
  }

  const browser = await browserType.launch(launchOptions);

  // Viewport size
  if (options.viewportSize) {
    try {
      const [ width, height ] = options.viewportSize.split(',').map(n => parseInt(n, 10));
      contextOptions.viewport = { width, height };
    } catch (e) {
      console.log('Invalid window size format: use "width, height", for example --window-size=800,600');
      process.exit(0);
    }
  }

  // Geolocation

  if (options.geolocation) {
    try {
      const [latitude, longitude] = options.geolocation.split(',').map(n => parseFloat(n.trim()));
      contextOptions.geolocation = {
        latitude,
        longitude
      };
    } catch (e) {
      console.log('Invalid geolocation format: user lat, long, for example --geolocation="37.819722,-122.478611"');
      process.exit(0);
    }
    contextOptions.permissions = ['geolocation'];
  }

  // User agent

  if (options.userAgent)
    contextOptions.userAgent = options.userAgent;

  // Lang

  if (options.lang)
    contextOptions.locale = options.lang;

  // Color scheme

  if (options.colorScheme)
    contextOptions.colorScheme = options.colorScheme as 'dark' | 'light';

  // Timezone

  if (options.timezone)
    contextOptions.timezoneId = options.timezone;

  // Storage

  if (options.loadStorage)
    contextOptions.storageState = options.loadStorage;

  if (options.ignoreHttpsErrors)
    contextOptions.ignoreHTTPSErrors = true;

  // Close app when the last window closes.

  const context = await browser.newContext(contextOptions);

  let closingBrowser = false;
  async function closeBrowser() {
    // We can come here multiple times. For example, saving storage creates
    // a temporary page and we call closeBrowser again when that page closes.
    if (closingBrowser)
      return;
    closingBrowser = true;
    if (options.saveTrace)
      await context.tracing.stop({ path: options.saveTrace });
    if (options.saveStorage)
      await context.storageState({ path: options.saveStorage }).catch(e => null);
    await browser.close();
  }

  context.on('page', page => {
    page.on('dialog', () => {});  // Prevent dialogs from being automatically dismissed.
    page.on('close', () => {
      const hasPage = browser.contexts().some(context => context.pages().length > 0);
      if (hasPage)
        return;
      // Avoid the error when the last page is closed because the browser has been closed.
      closeBrowser().catch(e => null);
    });
  });
  if (options.timeout) {
    context.setDefaultTimeout(parseInt(options.timeout, 10));
    context.setDefaultNavigationTimeout(parseInt(options.timeout, 10));
  }

  if (options.saveTrace)
    await context.tracing.start({ screenshots: true, snapshots: true });

  // Omit options that we add automatically for presentation purpose.
  delete launchOptions.headless;
  delete launchOptions.executablePath;
  delete contextOptions.deviceScaleFactor;
  return { browser, browserName: browserType.name(), context, contextOptions, launchOptions };
}

async function openPage(context: BrowserContext, url: string | undefined): Promise<Page> {
  const page = await context.newPage();
  if (url) {
    if (fs.existsSync(url))
      url = 'file://' + path.resolve(url);
    else if (!url.startsWith('http') && !url.startsWith('file://') && !url.startsWith('about:') && !url.startsWith('data:'))
      url = 'http://' + url;
    await page.goto(url);
  }
  return page;
}

async function open(options: Options, url: string | undefined, language: string) {
  const { context, launchOptions, contextOptions } = await launchContext(options, !!process.env.PWTEST_CLI_HEADLESS, process.env.PWTEST_CLI_EXECUTABLE_PATH);
  await context._enableRecorder({
    language,
    launchOptions,
    contextOptions,
    device: options.device,
    saveStorage: options.saveStorage,
  });
  await openPage(context, url);
  if (process.env.PWTEST_CLI_EXIT)
    await Promise.all(context.pages().map(p => p.close()));
}

export async function codegen(options: Options, url: string | undefined, language: string, outputFile?: string) {
    const {
      context,
      launchOptions,
      contextOptions
    } = await launchContext(options, !!process.env.PWTEST_CLI_HEADLESS, process.env.PWTEST_CLI_EXECUTABLE_PATH);
    await context._enableRecorder({
      language,
      launchOptions,
      contextOptions,
      device: options.device,
      saveStorage: options.saveStorage,
      startRecording: true,
      outputFile: outputFile ? path.resolve(outputFile) : undefined
    }); // 监听录制完成
    await openPage(context, url);
    if (process.env.PWTEST_CLI_EXIT) await Promise.all(context.pages().map(p => p.close()));
}

async function waitForPage(page: Page, captureOptions: CaptureOptions) {
  if (captureOptions.waitForSelector) {
    console.log(`Waiting for selector ${captureOptions.waitForSelector}...`);
    await page.waitForSelector(captureOptions.waitForSelector);
  }
  if (captureOptions.waitForTimeout) {
    console.log(`Waiting for timeout ${captureOptions.waitForTimeout}...`);
    await page.waitForTimeout(parseInt(captureOptions.waitForTimeout, 10));
  }
}

async function screenshot(options: Options, captureOptions: CaptureOptions, url: string, path: string) {
  const { browser, context } = await launchContext(options, true);
  console.log('Navigating to ' + url);
  const page = await openPage(context, url);
  await waitForPage(page, captureOptions);
  console.log('Capturing screenshot into ' + path);
  await page.screenshot({ path, fullPage: !!captureOptions.fullPage });
  await browser.close();
}

async function pdf(options: Options, captureOptions: CaptureOptions, url: string, path: string) {
  if (options.browser !== 'chromium') {
    console.error('PDF creation is only working with Chromium');
    process.exit(1);
  }
  const { browser, context } = await launchContext({ ...options, browser: 'chromium' }, true);
  console.log('Navigating to ' + url);
  const page = await openPage(context, url);
  await waitForPage(page, captureOptions);
  console.log('Saving as pdf into ' + path);
  await page.pdf!({ path });
  await browser.close();
}

function lookupBrowserType(options: Options): BrowserType {
  let name = options.browser;
  if (options.device) {
    const device = playwright.devices[options.device];
    name = device.defaultBrowserType;
  }
  let browserType: any;
  switch (name) {
    case 'chromium': browserType = playwright.chromium; break;
    case 'webkit': browserType = playwright.webkit; break;
    case 'firefox': browserType = playwright.firefox; break;
    case 'cr': browserType = playwright.chromium; break;
    case 'wk': browserType = playwright.webkit; break;
    case 'ff': browserType = playwright.firefox; break;
  }
  if (browserType)
    return browserType;
  program.help();
}

function validateOptions(options: Options) {
  if (options.device && !(options.device in playwright.devices)) {
    console.log(`Device descriptor not found: '${options.device}', available devices are:`);
    for (const name in playwright.devices)
      console.log(`  "${name}"`);
    process.exit(0);
  }
  if (options.colorScheme && !['light', 'dark'].includes(options.colorScheme)) {
    console.log('Invalid color scheme, should be one of "light", "dark"');
    process.exit(0);
  }
}

function logErrorAndExit(e: Error) {
  console.error(e);
  process.exit(1);
}

function language(): string {
  return process.env.PW_LANG_NAME || 'test';
}

function commandWithOpenOptions(command: string, description: string, options: any[][]): Command {
  let result = program.command(command).description(description);
  for (const option of options)
    result = result.option(option[0], ...option.slice(1));
  return result
      .option('-b, --browser <browserType>', 'browser to use, one of cr, chromium, ff, firefox, wk, webkit', 'chromium')
      .option('--channel <channel>', 'Chromium distribution channel, "chrome", "chrome-beta", "msedge-dev", etc')
      .option('--color-scheme <scheme>', 'emulate preferred color scheme, "light" or "dark"')
      .option('--device <deviceName>', 'emulate device, for example  "iPhone 11"')
      .option('--geolocation <coordinates>', 'specify geolocation coordinates, for example "37.819722,-122.478611"')
      .option('--ignore-https-errors', 'ignore https errors')
      .option('--load-storage <filename>', 'load context storage state from the file, previously saved with --save-storage')
      .option('--lang <language>', 'specify language / locale, for example "en-GB"')
      .option('--proxy-server <proxy>', 'specify proxy server, for example "http://myproxy:3128" or "socks5://myproxy:8080"')
      .option('--proxy-bypass <bypass>', 'comma-separated domains to bypass proxy, for example ".com,chromium.org,.domain.com"')
      .option('--save-storage <filename>', 'save context storage state at the end, for later use with --load-storage')
      .option('--save-trace <filename>', 'record a trace for the session and save it to a file')
      .option('--timezone <time zone>', 'time zone to emulate, for example "Europe/Rome"')
      .option('--timeout <timeout>', 'timeout for Playwright actions in milliseconds', '10000')
      .option('--user-agent <ua string>', 'specify user agent string')
      .option('--viewport-size <size>', 'specify browser viewport size in pixels, for example "1280, 720"');
}

async function launchGridServer(factoryPathOrPackageName: string, port: number, authToken: string|undefined): Promise<void> {
  if (!factoryPathOrPackageName)
    factoryPathOrPackageName = path.join('..', 'grid', 'simpleGridFactory');
  let factory;
  try {
    factory = require(path.resolve(factoryPathOrPackageName));
  } catch (e) {
    factory = require(factoryPathOrPackageName);
  }
  if (factory && typeof factory === 'object' && ('default' in factory))
    factory = factory['default'];
  if (!factory || !factory.launch || typeof factory.launch !== 'function')
    throw new Error('factory does not export `launch` method');
  factory.name = factory.name || factoryPathOrPackageName;
  const gridServer = new GridServer(factory as GridFactory, authToken);
  await gridServer.start(port);
  console.log('Grid server is running at ' + gridServer.urlPrefix());
}