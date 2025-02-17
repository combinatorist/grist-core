import {BillingTask} from 'app/common/BillingAPI';
import {delay} from 'app/common/delay';
import {DocCreationInfo} from 'app/common/DocListAPI';
import {encodeUrl, getSlugIfNeeded, GristLoadConfig, IGristUrlState, isOrgInPathOnly,
        parseSubdomain, sanitizePathTail} from 'app/common/gristUrls';
import {getOrgUrlInfo} from 'app/common/gristUrls';
import {UserProfile} from 'app/common/LoginSessionAPI';
import {tbind} from 'app/common/tbind';
import {UserConfig} from 'app/common/UserConfig';
import * as version from 'app/common/version';
import {ApiServer} from 'app/gen-server/ApiServer';
import {Document} from "app/gen-server/entity/Document";
import {Organization} from "app/gen-server/entity/Organization";
import {Workspace} from 'app/gen-server/entity/Workspace';
import {DocApiForwarder} from 'app/gen-server/lib/DocApiForwarder';
import {getDocWorkerMap} from 'app/gen-server/lib/DocWorkerMap';
import {HomeDBManager} from 'app/gen-server/lib/HomeDBManager';
import {Housekeeper} from 'app/gen-server/lib/Housekeeper';
import {Usage} from 'app/gen-server/lib/Usage';
import {attachAppEndpoint} from 'app/server/lib/AppEndpoint';
import {addRequestUser, getUser, getUserId, isSingleUserMode,
        redirectToLoginUnconditionally} from 'app/server/lib/Authorizer';
import {redirectToLogin, RequestWithLogin} from 'app/server/lib/Authorizer';
import {SessionUserObj} from 'app/server/lib/BrowserSession';
import * as Comm from 'app/server/lib/Comm';
import {create} from 'app/server/lib/create';
import {addDocApiRoutes} from 'app/server/lib/DocApi';
import {DocManager} from 'app/server/lib/DocManager';
import {DocStorageManager} from 'app/server/lib/DocStorageManager';
import {DocWorker} from 'app/server/lib/DocWorker';
import {DocWorkerInfo, IDocWorkerMap} from 'app/server/lib/DocWorkerMap';
import {expressWrap, jsonErrorHandler} from 'app/server/lib/expressWrap';
import {Hosts, RequestWithOrg} from 'app/server/lib/extractOrg';
import {GristLoginMiddleware,  GristServer} from 'app/server/lib/GristServer';
import {initGristSessions, SessionStore} from 'app/server/lib/gristSessions';
import {HostedStorageManager} from 'app/server/lib/HostedStorageManager';
import {IBilling} from 'app/server/lib/IBilling';
import {IDocStorageManager} from 'app/server/lib/IDocStorageManager';
import {INotifier} from 'app/server/lib/INotifier';
import * as log from 'app/server/lib/log';
import {getLoginMiddleware} from 'app/server/lib/logins';
import {IPermitStore} from 'app/server/lib/Permit';
import {getAppPathTo, getAppRoot, getUnpackedAppRoot} from 'app/server/lib/places';
import {addPluginEndpoints, limitToPlugins} from 'app/server/lib/PluginEndpoint';
import {PluginManager} from 'app/server/lib/PluginManager';
import {adaptServerUrl, addOrgToPath, addPermit, getScope, optStringParam, RequestWithGristInfo, stringParam,
        TEST_HTTPS_OFFSET, trustOrigin} from 'app/server/lib/requestUtils';
import {ISendAppPageOptions, makeGristConfig, makeSendAppPage} from 'app/server/lib/sendAppPage';
import {getDatabaseUrl} from 'app/server/lib/serverUtils';
import {Sessions} from 'app/server/lib/Sessions';
import * as shutdown from 'app/server/lib/shutdown';
import {TagChecker} from 'app/server/lib/TagChecker';
import {startTestingHooks} from 'app/server/lib/TestingHooks';
import {addUploadRoute} from 'app/server/lib/uploads';
import axios from 'axios';
import * as bodyParser from 'body-parser';
import * as express from 'express';
import * as fse from 'fs-extra';
import * as http from 'http';
import * as https from 'https';
import mapValues = require('lodash/mapValues');
import * as morganLogger from 'morgan';
import {AddressInfo} from 'net';
import fetch from 'node-fetch';
import * as path from 'path';
import * as serveStatic from "serve-static";

// Health checks are a little noisy in the logs, so we don't show them all.
// We show the first N health checks:
const HEALTH_CHECK_LOG_SHOW_FIRST_N = 10;
// And we show every Nth health check:
const HEALTH_CHECK_LOG_SHOW_EVERY_N = 100;

// DocID of Grist doc to collect the Welcome questionnaire responses.
const DOC_ID_NEW_USER_INFO = process.env.DOC_ID_NEW_USER_INFO || 'GristNewUserInfo';

export interface FlexServerOptions {
  dataDir?: string;

  // Base domain for org hostnames, starting with ".". Defaults to the base domain of APP_HOME_URL.
  baseDomain?: string;
  // Base URL for plugins, if permitted. Defaults to APP_UNTRUSTED_URL.
  pluginUrl?: string;
}

export interface RequestWithGrist extends express.Request {
  gristServer?: GristServer;
}

export class FlexServer implements GristServer {
  public readonly create = create;
  public tagChecker: TagChecker;
  public app: express.Express;
  public deps: Set<string> = new Set();
  public appRoot: string;
  public host: string;
  public tag: string;
  public info = new Array<[string, any]>();
  public sessions: Sessions;
  public dbManager: HomeDBManager;
  public notifier: INotifier;
  public usage: Usage;
  public housekeeper: Housekeeper;
  public server: http.Server;
  public httpsServer?: https.Server;
  public comm: Comm;
  public settings: any;
  public worker: DocWorkerInfo;
  public electronServerMethods: ElectronServerMethods;
  public readonly docsRoot: string;
  private _defaultBaseDomain: string|undefined;
  private _pluginUrl: string|undefined;
  private _billing: IBilling;
  private _instanceRoot: string;
  private _docManager: DocManager;
  private _docWorker: DocWorker;
  private _hosts: Hosts;
  private _pluginManager: PluginManager;
  private _sessionStore: SessionStore;
  private _storageManager: IDocStorageManager;
  private _docWorkerMap: IDocWorkerMap;
  private _disabled: boolean = false;
  private _disableS3: boolean = false;
  private _healthy: boolean = true;  // becomes false if a serious error has occurred and
                                     // server cannot do its work.
  private _healthCheckCounter: number = 0;
  private _hasTestingHooks: boolean = false;
  private _loginMiddleware: GristLoginMiddleware;
  private _userIdMiddleware: express.RequestHandler;
  private _trustOriginsMiddleware: express.RequestHandler;
  private _docPermissionsMiddleware: express.RequestHandler;
  // This middleware redirects to signin/signup for anon, except on merged org or for
  // a team site that allows anon access.
  private _redirectToLoginWithExceptionsMiddleware: express.RequestHandler;
  // This unconditionally redirects to signin/signup for anon, for pages where anon access
  // is never desired.
  private _redirectToLoginWithoutExceptionsMiddleware: express.RequestHandler;
  // This can be called to do a redirect to signin/signup in a nuanced situation.
  private _redirectToLoginUnconditionally: express.RequestHandler | null;
  private _redirectToOrgMiddleware: express.RequestHandler;
  private _redirectToHostMiddleware: express.RequestHandler;
  private _getLoginRedirectUrl: (target: URL) => Promise<string>;
  private _getSignUpRedirectUrl: (target: URL) => Promise<string>;
  private _getLogoutRedirectUrl: (nextUrl: URL, userSession: SessionUserObj) => Promise<string>;
  private _sendAppPage: (req: express.Request, resp: express.Response, options: ISendAppPageOptions) => Promise<void>;

  constructor(public port: number, public name: string = 'flexServer',
              public readonly options: FlexServerOptions = {}) {
    this.app = express();
    this.app.set('port', port);
    this.appRoot = getAppRoot();
    this.host = process.env.GRIST_HOST || "localhost";
    log.info(`== Grist version is ${version.version} (commit ${version.gitcommit})`);
    this.info.push(['appRoot', this.appRoot]);
    // This directory hold Grist documents.
    this.docsRoot = fse.realpathSync(path.resolve((this.options && this.options.dataDir) ||
                                                  process.env.GRIST_DATA_DIR ||
                                                  getAppPathTo(this.appRoot, 'samples')));
    this.info.push(['docsRoot', this.docsRoot]);

    const homeUrl = process.env.APP_HOME_URL;
    this._defaultBaseDomain = options.baseDomain || (homeUrl && parseSubdomain(new URL(homeUrl).hostname).base);
    this.info.push(['defaultBaseDomain', this._defaultBaseDomain]);
    this._pluginUrl = options.pluginUrl || process.env.APP_UNTRUSTED_URL;
    this.info.push(['pluginUrl', this._pluginUrl]);

    this.app.use((req, res, next) => {
      (req as RequestWithGrist).gristServer = this;
      next();
    });
  }

  public getHost(): string {
    return `${this.host}:${this.getOwnPort()}`;
  }

  // Get a url for this server, based on the protocol it speaks (http), the host it
  // runs on, and the port it listens on.  The url the client uses to communicate with
  // the server may be different if there are intermediaries (such as a load-balancer
  // terminating TLS).
  public getOwnUrl(): string {
    const port = this.getOwnPort();
    return `http://${this.host}:${port}`;
  }

  /**
   * Get a url for the home server api.  Called without knowledge of a specific
   * request, so will default to a generic url.  Use of this method can render
   * code incompatible with custom base domains (currently, sendgrid notifications
   * via Notifier are incompatible for this reason).
   */
  public getDefaultHomeUrl(): string {
    const homeUrl = process.env.APP_HOME_URL || (this._has('api') && this.getOwnUrl());
    if (!homeUrl) { throw new Error("need APP_HOME_URL"); }
    return homeUrl;
  }

  /**
   * Get a url for the home server api, adapting it to match the base domain in the
   * requested url.  This adaptation is important for cookie-based authentication.
   *
   * If relPath is given, returns that path relative to homeUrl. If omitted, note that
   * getHomeUrl() will still return a URL ending in "/".
   */
  public getHomeUrl(req: express.Request, relPath: string = ''): string {
    // Get the default home url.
    const homeUrl = new URL(relPath, this.getDefaultHomeUrl());
    adaptServerUrl(homeUrl, req as RequestWithOrg);
    return homeUrl.href;
  }

  /**
   * Get a home url that is appropriate for the given document.  For now, this
   * returns a default that works for all documents.  That could change in future,
   * specifically with custom domains (perhaps we might limit which docs can be accessed
   * based on domain).
   */
  public async getHomeUrlByDocId(docId: string, relPath: string = ''): Promise<string> {
    return new URL(relPath, this.getDefaultHomeUrl()).href;
  }

  // Get the port number the server listens on.  This may be different from the port
  // number the client expects when communicating with the server if there are intermediaries.
  public getOwnPort(): number {
    // Get the port from the server in case it was started with port 0.
    return this.server ? (this.server.address() as AddressInfo).port : this.port;
  }

  public getPermitStore(): IPermitStore {
    if (!this._docWorkerMap) { throw new Error('no permit store available'); }
    return this._docWorkerMap;
  }

  public addLogging() {
    if (this._check('logging')) { return; }
    if (process.env.GRIST_LOG_SKIP_HTTP) { return; }
    // Add a timestamp token that matches exactly the formatting of non-morgan logs.
    morganLogger.token('logTime', (req: Request) => log.timestamp());
    // Add an optional gristInfo token that can replace the url, if the url is sensitive
    // (this is the case for some cognito login urls).
    morganLogger.token('gristInfo', (req: RequestWithGristInfo) =>
                       req.gristInfo || req.originalUrl || req.url);
    morganLogger.token('host', (req: express.Request) => req.get('host'));
    const msg = ':logTime :host :method :gristInfo :status :response-time ms - :res[content-length]';
    // In hosted Grist, render json so logs retain more organization.
    function outputJson(tokens: any, req: any, res: any) {
      return JSON.stringify({
        timestamp: tokens.logTime(req, res),
        method: tokens.method(req, res),
        path: tokens.gristInfo(req, res),
        status: tokens.status(req, res),
        timeMs: parseFloat(tokens['response-time'](req, res)) || undefined,
        contentLength: parseInt(tokens.res(req, res, 'content-length'), 10) || undefined,
        host: tokens.host(req, res)
      });
    }
    this.app.use(morganLogger(process.env.GRIST_HOSTED_VERSION ? outputJson : msg, {
      skip: this._shouldSkipRequestLogging.bind(this)
    }));
  }

  public addHealthCheck() {
    if (this._check('health')) { return; }
    // Health check endpoint. if called with /hooks, testing hooks are required in order to be
    // considered healthy.  Testing hooks are used only in server started for tests, and
    // /status/hooks allows the tests to wait for them to be ready.
    this.app.get('/status(/hooks)?', (req, res) => {
      if (this._healthy && (this._hasTestingHooks || !req.url.endsWith('/hooks'))) {
        this._healthCheckCounter++;
        res.status(200).send(`Grist ${this.name} is alive.`);
      } else {
        this._healthCheckCounter = 0;  // reset counter if we ever go internally unhealthy.
        res.status(500).send(`Grist ${this.name} is unhealthy.`);
      }
    });
  }

  public testAddRouter() {
    if (this._check('router')) { return; }
    this.app.get('/test/router', (req, res) => {
      const act = optStringParam(req.query.act) || 'none';
      const port = stringParam(req.query.port);  // port is trusted in mock; in prod it is not.
      if (act === 'add' || act === 'remove') {
        const host = `localhost:${port}`;
        return res.status(200).json({
          act,
          host,
          url: `http://${host}`,
          message: 'ok',
        });
      }
      return res.status(500).json({error: 'unrecognized action'});
    });
  }

  public addCleanup() {
    if (this._check('cleanup')) { return; }
    // Set up signal handlers. Note that nodemon sends SIGUSR2 to restart node.
    shutdown.cleanupOnSignals('SIGINT', 'SIGTERM', 'SIGHUP', 'SIGUSR2');
  }

  public addTagChecker() {
    if (this._check('tag', '!org')) { return; }
    // Handle requests that start with /v/TAG/ and set .tag property on them.
    this.tag = version.gitcommit;
    this.info.push(['tag', this.tag]);
    this.tagChecker = new TagChecker(this.tag);
    this.app.use(this.tagChecker.inspectTag);
  }

  /**
   * To allow routing to doc workers via the path, doc workers remove any
   * path prefix of the form /dw/...../ if present.  The prefix is not checked,
   * just removed unconditionally.
   * TODO: determine what the prefix should be, and check it, to catch bugs.
   */
  public stripDocWorkerIdPathPrefixIfPresent() {
    if (this._check('strip_dw', '!tag', '!org')) { return; }
    this.app.use((req, resp, next) => {
      const match = req.url.match(/^\/dw\/([-a-zA-Z0-9]+)([/?].*)?$/);
      if (match) { req.url = sanitizePathTail(match[2]); }
      next();
    });
  }

  public addOrg() {
    if (this._check('org', 'homedb', 'hosts')) { return; }
    this.app.use(this._hosts.extractOrg);
  }

  public setDirectory() {
    if (this._check('dir')) { return; }
    process.chdir(getUnpackedAppRoot(this.appRoot));
  }

  public get instanceRoot() {
    if (!this._instanceRoot) {
      this._instanceRoot = path.resolve(process.env.GRIST_INST_DIR || this.appRoot);
      this.info.push(['instanceRoot', this._instanceRoot]);
    }
    return this._instanceRoot;
  }

  public addStaticAndBowerDirectories() {
    if (this._check('static_and_bower', 'dir')) { return; }
    this.addTagChecker();
    // Allow static files to be requested from any origin.
    const options: serveStatic.ServeStaticOptions = {
      setHeaders: (res, filepath, stat) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
      }
    };
    // Grist has static help files, which may be useful for standalone app,
    // but for hosted grist the latest help is at support.getgrist.com.  Redirect
    // to this page for the benefit of crawlers which currently rank the static help
    // page link highly for historic reasons.
    this.app.use(/^\/help\//, expressWrap(async (req, res) => {
      res.redirect('https://support.getgrist.com');
    }));
    const staticApp = express.static(getAppPathTo(this.appRoot, 'static'), options);
    const bowerApp = express.static(getAppPathTo(this.appRoot, 'bower_components'), options);
    this.app.use(this.tagChecker.withTag(staticApp));
    this.app.use(this.tagChecker.withTag(bowerApp));
  }

  // Some tests rely on testFOO.html files being served.
  public addAssetsForTests() {
    if (this._check('testAssets', 'dir')) { return; }
    // Serve test[a-z]*.html for test purposes.
    this.app.use(/^\/(test[a-z]*.html)$/i, expressWrap(async (req, res) =>
      res.sendFile(req.params[0], {root: getAppPathTo(this.appRoot, 'static')})));
  }

  // Plugin operation relies currently on grist-plugin-api.js being available,
  // and with Grist's static assets to be also available on the untrusted
  // host.  The assets should be available without version tags.
  public async addAssetsForPlugins() {
    if (this._check('pluginUntaggedAssets', 'dir')) { return; }
    this.app.use(/^\/(grist-plugin-api.js)$/, expressWrap(async (req, res) =>
      res.sendFile(req.params[0], {root: getAppPathTo(this.appRoot, 'static')})));
    // Plugins get access to static resources without a tag
    this.app.use(limitToPlugins(express.static(getAppPathTo(this.appRoot, 'static'))));
    this.app.use(limitToPlugins(express.static(getAppPathTo(this.appRoot, 'bower_components'))));
    this.addOrg();
    addPluginEndpoints(this, await this._addPluginManager());
  }

  // Prepare cache for managing org-to-host relationship.
  public addHosts() {
    if (this._check('hosts', 'homedb')) { return; }
    this._hosts = new Hosts(this._defaultBaseDomain, this.dbManager, this._pluginUrl);
  }

  public async initHomeDBManager() {
    if (this._check('homedb')) { return; }
    this.dbManager = new HomeDBManager();
    this.dbManager.setPrefix(process.env.GRIST_ID_PREFIX || "");
    await this.dbManager.connect();
    await this.dbManager.initializeSpecialIds();
    // If working without a login system, make sure default user exists.
    if (process.env.GRIST_DEFAULT_EMAIL) {
      const profile: UserProfile = {
        name: 'You',
        email: process.env.GRIST_DEFAULT_EMAIL,
      };
      const user = await this.dbManager.getUserByLoginWithRetry(profile.email, profile);
      if (user) {
        // No need to survey this user!
        user.isFirstTimeUser = false;
        await user.save();
      }
    }
    // Report which database we are using, without sensitive credentials.
    this.info.push(['database', getDatabaseUrl(this.dbManager.connection.options, false)]);
  }

  public addDocWorkerMap() {
    if (this._check('map')) { return; }
    this._docWorkerMap = getDocWorkerMap();
  }

  // Set up the main express middleware used.  For a single user setup, without logins,
  // all this middleware is currently a no-op.
  public addAccessMiddleware() {
    if (this._check('middleware', 'map', isSingleUserMode() ? null : 'hosts')) { return; }

    if (!isSingleUserMode()) {
      // Middleware to redirect landing pages to preferred host
      this._redirectToHostMiddleware = this._hosts.redirectHost;
      // Middleware to add the userId to the express request object.
      // If GRIST_DEFAULT_EMAIL is set, login as that user when no other credentials
      // presented.
      const fallbackEmail = process.env.GRIST_DEFAULT_EMAIL || null;
      this._userIdMiddleware = expressWrap(addRequestUser.bind(null, this.dbManager, this._docWorkerMap,
                                                               fallbackEmail));
      this._trustOriginsMiddleware = expressWrap(trustOriginHandler);
      // middleware to authorize doc access to the app. Note that this requires the userId
      // to be set on the request by _userIdMiddleware.
      this._docPermissionsMiddleware = expressWrap((...args) => this._docWorker.assertDocAccess(...args));
      this._redirectToLoginWithExceptionsMiddleware = redirectToLogin(true,
                                                                      this._getLoginRedirectUrl,
                                                                      this._getSignUpRedirectUrl,
                                                                      this.dbManager);
      this._redirectToLoginWithoutExceptionsMiddleware = redirectToLogin(false,
                                                                         this._getLoginRedirectUrl,
                                                                         this._getSignUpRedirectUrl,
                                                                         this.dbManager);
      this._redirectToLoginUnconditionally = redirectToLoginUnconditionally(this._getLoginRedirectUrl,
                                                                            this._getSignUpRedirectUrl);
      this._redirectToOrgMiddleware = tbind(this._redirectToOrg, this);
    } else {
      const noop: express.RequestHandler = (req, res, next) => next();
      this._userIdMiddleware = noop;
      this._trustOriginsMiddleware = noop;
      this._docPermissionsMiddleware = (req, res, next) => {
        // For standalone single-user Grist, documents are stored on-disk
        // with their filename equal to the document title, no document
        // aliases are possible, and there is no access control.
        // The _docPermissionsMiddleware is a no-op.
        // TODO We might no longer have any tests for isSingleUserMode, or modes of operation.
        next();
      };
      this._redirectToLoginWithExceptionsMiddleware = noop;
      this._redirectToLoginWithoutExceptionsMiddleware = noop;
      this._redirectToLoginUnconditionally = null;  // there is no way to log in.
      this._redirectToOrgMiddleware = noop;
      this._redirectToHostMiddleware = noop;
    }
  }

  /**
   * Add middleware common to all API endpoints (including forwarding ones).
   */
  public addApiMiddleware() {
    if (this._check('api-mw', 'middleware')) { return; }
    // API endpoints need req.userId and need to support requests from different subdomains.
    this.app.use("/api", this._userIdMiddleware);
    this.app.use("/api", this._trustOriginsMiddleware);
    this.app.use("/api", noCaching);
  }

  /**
   * Add error-handling middleware common to all API endpoints.
   */
  public addApiErrorHandlers() {
    if (this._check('api-error', 'api-mw')) { return; }

    // add a final not-found handler for api
    this.app.use("/api", (req, res) => {
      res.status(404).send({error: `not found: ${req.originalUrl}`});
    });

    // Add a final error handler for /api endpoints that reports errors as JSON.
    this.app.use('/api', jsonErrorHandler);
  }

  public addHomeApi() {
    if (this._check('api', 'homedb', 'json', 'api-mw')) { return; }

    // ApiServer's constructor adds endpoints to the app.
    // tslint:disable-next-line:no-unused-expression
    new ApiServer(this.app, this.dbManager);
  }

  public addBillingApi() {
    if (this._check('billing-api', 'homedb', 'json', 'api-mw')) { return; }
    this._getBilling();
    this._billing.addEndpoints(this.app);
    this._billing.addEventHandlers();
  }

  /**
   * Add a /api/log endpoint that simply outputs client errors to our
   * logs.  This is a minimal placeholder for a special-purpose
   * service for dealing with client errors.
   */
  public addLogEndpoint() {
    if (this._check('log-endpoint', 'json', 'api-mw')) { return; }
    this.app.post('/api/log', expressWrap(async (req, resp) => {
      const mreq = req as RequestWithLogin;
      log.rawWarn('client error', {
        event: req.body.event,
        page: req.body.page,
        browser: req.body.browser,
        org: mreq.org,
        email: mreq.user && mreq.user.loginEmail,
        userId: mreq.userId,
      });
      return resp.status(200).send();
    }));
  }

  public async close() {
    if (this._hosts) { this._hosts.close(); }
    if (this.dbManager) {
      this.dbManager.removeAllListeners();
      this.dbManager.flushDocAuthCache();
    }
    if (this.server)      { this.server.close(); }
    if (this.httpsServer) { this.httpsServer.close(); }
    if (this.usage)       { this.usage.close(); }
    if (this.housekeeper) { await this.housekeeper.stop(); }
    await this._shutdown();
    // Do this after _shutdown, since DocWorkerMap is used during shutdown.
    if (this._docWorkerMap) { await this._docWorkerMap.close(); }
    if (this._sessionStore) { await this._sessionStore.close(); }
  }

  public addDocApiForwarder() {
    if (this._check('doc_api_forwarder', '!json', 'homedb', 'api-mw', 'map')) { return; }
    const docApiForwarder = new DocApiForwarder(this._docWorkerMap, this.dbManager);
    docApiForwarder.addEndpoints(this.app);
  }

  public addJsonSupport() {
    if (this._check('json')) { return; }
    this.app.use(bodyParser.json({limit: '1mb'}));  // Increase from the default 100kb
  }

  public addSessions() {
    if (this._check('sessions', 'config')) { return; }
    this.addTagChecker();
    this.addOrg();

    // Create the sessionStore and related objects.
    const {sessions, sessionMiddleware, sessionStore} = initGristSessions(this.instanceRoot, this);
    this.app.use(sessionMiddleware);

    // Create an endpoint for making cookies during testing.
    this.app.get('/test/session', async (req, res) => {
      (req as any).session.alive = true;
      res.status(200).send(`Grist ${this.name} is alive and is interested in you.`);
    });

    this.sessions = sessions;
    this._sessionStore = sessionStore;
  }

  // Close connections and stop accepting new connections.  Remove server from any lists
  // it may be in.
  public async stopListening(mode: 'crash'|'clean' = 'clean') {
    if (!this._disabled) {
      if (mode === 'clean') {
        await this._shutdown();
        this._disabled = true;
      } else {
        this._disabled = true;
        if (this.comm) {
          this.comm.setServerActivation(false);
          this.comm.destroyAllClients();
        }
      }
      this.server.close();
      if (this.httpsServer) { this.httpsServer.close(); }
    }
  }

  public async createWorkerUrl(): Promise<{url: string, host: string}> {
    if (!process.env.GRIST_ROUTER_URL) {
      throw new Error('No service available to create worker url');
    }
    const w = await axios.get(process.env.GRIST_ROUTER_URL,
                              {params: {act: 'add', port: this.getOwnPort()}});
    log.info(`DocWorker registered itself via ${process.env.GRIST_ROUTER_URL} as ${w.data.url}`);
    const statusUrl = `${w.data.url}/status`;
    // We now wait for the worker to be available from the url that clients will
    // use to connect to it.  This may take some time.  The main delay is the
    // new target group and load balancer rule taking effect - typically 10-20 seconds.
    // If we don't wait, the worker will end up registered for work and clients
    // could end up trying to reach it to open documents - but the url they have
    // won't work.
    for (let tries = 0; tries < 600; tries++) {
      await delay(1000);
      try {
        await axios.get(statusUrl);
        return w.data;
      } catch (err) {
        log.debug(`While waiting for ${statusUrl} got error ${err.message}`);
      }
    }
    throw new Error(`Cannot connect to ${statusUrl}`);
  }

  // Accept new connections again.  Add server to any lists it needs to be in to get work.
  public async restartListening() {
    if (!this._docWorkerMap) { throw new Error('expected to have DocWorkerMap'); }
    await this.stopListening('clean');
    if (this._disabled) {
      if (this._storageManager) {
        this._storageManager.testReopenStorage();
      }
      this.comm.setServerActivation(true);
      if (this.worker) {
        await this._startServers(this.server, this.httpsServer, this.name, this.port, false);
        await this._addSelfAsWorker(this._docWorkerMap);
      }
      this._disabled = false;
    }
  }

  public addLandingPages() {
    // TODO: check if isSingleUserMode() path can be removed from this method
    if (this._check('landing', 'map', isSingleUserMode() ? null : 'homedb')) { return; }
    this.addSessions();

    // Initialize _sendAppPage helper.
    this._sendAppPage = makeSendAppPage({
      server: isSingleUserMode() ? null : this,
      staticDir: getAppPathTo(this.appRoot, 'static'),
      tag: this.tag,
      testLogin: allowTestLogin(),
      baseDomain: this._defaultBaseDomain,
    });

    const welcomeNewUser: express.RequestHandler = isSingleUserMode() ?
      (req, res, next) => next() :
      expressWrap(async (req, res, next) => {
        const mreq = req as RequestWithLogin;
        const user = getUser(req);
        if (user && user.isFirstTimeUser) {
          log.debug(`welcoming user: ${user.name}`);
          const prefix = isOrgInPathOnly(req.hostname) ? `/o/${mreq.org}` : '';
          return res.redirect(`${prefix}/welcome/user`);
        }
        next();
      });

    attachAppEndpoint({
      app: this.app,
      middleware: [
        this._redirectToHostMiddleware,
        this._userIdMiddleware,
        this._redirectToLoginWithExceptionsMiddleware,
        this._redirectToOrgMiddleware,
        welcomeNewUser
      ],
      docMiddleware: [
        // Same as middleware, except without login redirect middleware.
        this._redirectToHostMiddleware,
        this._userIdMiddleware,
        this._redirectToOrgMiddleware,
        welcomeNewUser
      ],
      forceLogin: this._redirectToLoginUnconditionally,
      docWorkerMap: isSingleUserMode() ? null : this._docWorkerMap,
      sendAppPage: this._sendAppPage,
      dbManager: this.dbManager,
    });
  }

  // Load user config file from standard location.  Alternatively, a config object
  // can be supplied, in which case no file is needed.  The notion of a user config
  // file doesn't mean much in hosted grist, so it is convenient to be able to skip it.
  public async loadConfig(settings?: UserConfig) {
    if (this._check('config')) { return; }
    if (!settings) {
      const settingsPath = path.join(this.instanceRoot, 'config.json');
      if (await fse.pathExists(settingsPath)) {
        log.info(`Loading config from ${settingsPath}`);
        this.settings = JSON.parse(await fse.readFile(settingsPath, 'utf8'));
      } else {
        log.info(`Loading empty config because ${settingsPath} missing`);
        this.settings = {};
      }
    } else {
      this.settings = settings;
    }

    // TODO: We could include a third mock provider of login/logout URLs for better tests. Or we
    // could create a mock SAML identity provider for testing this using the SAML flow.
    this._loginMiddleware = await getLoginMiddleware();
    this._getLoginRedirectUrl = tbind(this._loginMiddleware.getLoginRedirectUrl, this._loginMiddleware);
    this._getSignUpRedirectUrl = tbind(this._loginMiddleware.getSignUpRedirectUrl, this._loginMiddleware);
    this._getLogoutRedirectUrl = tbind(this._loginMiddleware.getLogoutRedirectUrl, this._loginMiddleware);
  }

  public addComm() {
    if (this._check('comm', 'start')) { return; }
    this.comm = new Comm(this.server, {
      settings: this.settings,
      sessions: this.sessions,
      instanceStore: null,   // no instanceStore
      hosts: this._hosts,
      httpsServer: this.httpsServer,
    });
  }

  public addLoginRoutes() {
    if (this._check('login', 'org', 'sessions')) { return; }
    // TODO: We do NOT want Comm here at all, it's only being used for handling sessions, which
    // should be factored out of it.
    this.addComm();

    async function redirectToLoginOrSignup(
      this: FlexServer, signUp: boolean|null, req: express.Request, resp: express.Response,
    ) {
      const mreq = req as RequestWithLogin;
      mreq.session.alive = true;  // This will ensure that express-session will set our cookie
                                  // if it hasn't already - we'll need it when we come back
                                  // from Cognito.
      // Redirect to "/" on our requested hostname (in test env, this will redirect further)
      const next = req.protocol + '://' + req.get('host') + '/';
      if (signUp === null) {
        // Like redirectToLogin in Authorizer, redirect to sign up if it doesn't look like the
        // user has ever logged in on this browser.
        signUp = (mreq.session.users === undefined);
      }
      const getRedirectUrl = signUp ? this._getSignUpRedirectUrl : this._getLoginRedirectUrl;
      resp.redirect(await getRedirectUrl(new URL(next)));
    }

    this.app.get('/login', expressWrap(redirectToLoginOrSignup.bind(this, false)));
    this.app.get('/signup', expressWrap(redirectToLoginOrSignup.bind(this, true)));
    this.app.get('/signin', expressWrap(redirectToLoginOrSignup.bind(this, null)));

    if (allowTestLogin()) {
      // This is an endpoint for the dev environment that lets you log in as anyone.
      // For a standard dev environment, it will be accessible at localhost:8080/test/login
      // and localhost:8080/o/<org>/test/login.  Only available when GRIST_TEST_LOGIN is set.
      // Handy when without network connectivity to reach Cognito.

      log.warn("Adding a /test/login endpoint because GRIST_TEST_LOGIN is set. " +
        "Users will be able to login as anyone.");

      this.app.get('/test/login', expressWrap(async (req, res) => {
        log.warn("Serving unauthenticated /test/login endpoint, made available because GRIST_TEST_LOGIN is set.");

        const session = this.sessions.getOrCreateSessionFromRequest(req);
        const profile: UserProfile = {
          email: optStringParam(req.query.email) || 'chimpy@getgrist.com',
          name: optStringParam(req.query.name) || 'Chimpy McBanana',
        };
        await session.scopedSession.operateOnScopedSession(async user => {
          user.profile = profile;
          return user;
        });
        res.send(`<!doctype html>
          <html><body>
          <p>Logged in as ${JSON.stringify(profile)}.<p>
          <form>
          <input type=text name=email placeholder=email>
          <input type=text name=name placeholder=name>
          <input type=submit value=login>
          </form>
          </body></html>
       `);
      }));
    }

    this.app.get('/logout', expressWrap(async (req, resp) => {
      const session = this.sessions.getOrCreateSessionFromRequest(req);
      const userSession = await session.scopedSession.getScopedSession();

      // If 'next' param is missing, redirect to "/" on our requested hostname.
      const next = optStringParam(req.query.next) || (req.protocol + '://' + req.get('host') + '/');
      const redirectUrl = await this._getLogoutRedirectUrl(new URL(next), userSession);

      // Clear session so that user needs to log in again at the next request.
      // SAML logout in theory uses userSession, so clear it AFTER we compute the URL.
      // Express-session will save these changes.
      const expressSession = (req as any).session;
      if (expressSession) { expressSession.users = []; expressSession.orgToUser = {}; }
      if (session.loginSession) {
        await session.loginSession.clearSession();
      }
      resp.redirect(redirectUrl);
    }));

    // Add a static "signed-out" page. This is where logout typically lands (after redirecting
    // through Cognito or SAML).
    this.app.get('/signed-out', expressWrap((req, resp) =>
      this._sendAppPage(req, resp, {path: 'error.html', status: 200, config: {errPage: 'signed-out'}})));

    // Add a static "verified" page.  This is where an email verification link will land,
    // on success.  TODO: rename simple static pages from "error" to something more generic.
    this.app.get('/verified', expressWrap((req, resp) =>
      this._sendAppPage(req, resp, {path: 'error.html', status: 200, config: {errPage: 'verified'}})));

    const comment = this._loginMiddleware.addEndpoints(this.app, this.comm, this.sessions, this._hosts);
    this.info.push(['loginMiddlewareComment', comment]);
  }

  public async addTestingHooks(workerServers?: FlexServer[]) {
    if (process.env.GRIST_TESTING_SOCKET) {
      await startTestingHooks(process.env.GRIST_TESTING_SOCKET, this.port, null!, this.comm, this,
                              workerServers || []);
      this._hasTestingHooks = true;
    }
  }

  // Returns a Map from docId to number of connected clients for each doc.
  public async getDocClientCounts(): Promise<Map<string, number>> {
    return this._docManager ? this._docManager.getDocClientCounts() : new Map();
  }

  // allow the document manager to be specified externally, for convenience in testing.
  public testSetDocManager(docManager: DocManager) {
    this._docManager = docManager;
  }

  // Add document-related endpoints and related support.
  public async addDoc() {
    this._check('doc', 'start', 'tag', 'json', isSingleUserMode() ? null : 'homedb', 'api-mw', 'map');
    // add handlers for cleanup, if we are in charge of the doc manager.
    if (!this._docManager) { this.addCleanup(); }
    await this.loadConfig();
    this.addComm();

    if (!isSingleUserMode()) {
      if (!process.env.GRIST_DOCS_S3_BUCKET || process.env.GRIST_DISABLE_S3 === 'true') {
        this._disableS3 = true;
      }
      for (const [key, val] of Object.entries(this.create.configurationOptions())) {
        this.info.push([key, val]);
      }
      if (this._disableS3) {
        this.info.push(['s3', 'disabled']);
      }

      const workers = this._docWorkerMap;
      const docWorkerId = await this._addSelfAsWorker(workers);

      const storageManager = new HostedStorageManager(this.docsRoot, docWorkerId, this._disableS3, '', workers,
                                                      this.dbManager, this.create);
      this._storageManager = storageManager;
    } else {
      const samples = getAppPathTo(this.appRoot, 'public_samples');
      const storageManager = new DocStorageManager(this.docsRoot, samples, this.comm, this);
      this._storageManager = storageManager;
    }

    const pluginManager = await this._addPluginManager();
    this._docManager = this._docManager || new DocManager(this._storageManager, pluginManager,
                                                          this.dbManager, this);
    const docManager = this._docManager;

    shutdown.addCleanupHandler(null, this._shutdown.bind(this), 25000, 'FlexServer._shutdown');

    if (isSingleUserMode()) {
      // Load standalone stuff only if needed.  Hosted grist doesn't currently need basket,
      // sharing, etc.
      const extras = await import('app/server/lib/StandaloneExtras');
      this.electronServerMethods = extras.addStandaloneMethods({
        flexServer: this,
        docManager: this._docManager,
        storageManager: this._storageManager,
      });
    } else {
      this.comm.registerMethods({
        openDoc:                  docManager.openDoc.bind(docManager),
      });
      this._serveDocPage();
    }

    // Attach docWorker endpoints and Comm methods.
    const docWorker = new DocWorker(this.dbManager, {comm: this.comm});
    this._docWorker = docWorker;

    // Register the websocket comm functions associated with the docworker.
    docWorker.registerCommCore();
    docWorker.registerCommPlugin();

    // Doc-specific endpoints require authorization; collect the relevant middleware in one list.
    const docAccessMiddleware = [
      this._userIdMiddleware,
      this._docPermissionsMiddleware,
      this.tagChecker.requireTag
    ];

    this.addSupportPaths(docAccessMiddleware);

    if (!isSingleUserMode()) {
      addDocApiRoutes(this.app, docWorker, this._docWorkerMap, docManager, this.dbManager, this);
    }
  }

  public disableS3() {
    if (this.deps.has('doc')) {
      throw new Error('disableS3 called too late');
    }
    this._disableS3 = true;
  }

  public addBillingPages() {
    const middleware = [
      this._redirectToHostMiddleware,
      this._userIdMiddleware,
      this._redirectToLoginWithoutExceptionsMiddleware
    ];

    this.app.get('/billing', ...middleware, expressWrap(async (req, resp, next) => {
      const mreq = req as RequestWithLogin;
      const orgDomain = mreq.org;
      if (!orgDomain) {
        return this._sendAppPage(req, resp, {path: 'error.html', status: 404, config: {errPage: 'not-found'}});
      }
      // Allow the support user access to billing pages.
      const scope = addPermit(getScope(mreq), this.dbManager.getSupportUserId(), {org: orgDomain});
      const query = await this.dbManager.getOrg(scope, orgDomain);
      const org = this.dbManager.unwrapQueryResult(query);
      // This page isn't availabe for personal site.
      if (org.owner) {
        return this._sendAppPage(req, resp, {path: 'error.html', status: 404, config: {errPage: 'not-found'}});
      }
      return this._sendAppPage(req, resp, {path: 'billing.html', status: 200, config: {}});
    }));

    this.app.get('/billing/payment', ...middleware, expressWrap(async (req, resp, next) => {
      const task = optStringParam(req.query.billingTask) || '';
      const planRequired = task === 'signup' || task === 'updatePlan';
      if (!BillingTask.guard(task) || (planRequired && !req.query.billingPlan)) {
        // If the payment task/plan are invalid, redirect to the summary page.
        return resp.redirect(req.protocol + '://' + req.get('host') + `/billing`);
      } else {
        return this._sendAppPage(req, resp, {path: 'billing.html', status: 200, config: {}});
      }
    }));

    // This endpoint is used only during testing, to support existing tests that
    // depend on a page that has been removed.
    this.app.get('/test/support/billing/plans', expressWrap(async (req, resp, next) => {
      return this._sendAppPage(req, resp, {path: 'billing.html', status: 200, config: {}});
    }));
  }

  /**
   * Add billing webhooks.  Strip signatures sign the raw body of the message, so
   * we need to get these webhooks in before the bodyParser is added to parse json.
   */
  public addEarlyWebhooks() {
    if (this._check('webhooks', 'homedb')) { return; }
    if (this.deps.has('json')) {
      throw new Error('addEarlyWebhooks called too late');
    }
    this._getBilling();
    this._billing.addWebhooks(this.app);
  }

  public addWelcomePaths() {
    const middleware = [
      this._redirectToHostMiddleware,
      this._userIdMiddleware,
      this._redirectToLoginWithoutExceptionsMiddleware,
    ];

    this.app.get('/welcome/:page', ...middleware, expressWrap(async (req, resp, next) => {
      return this._sendAppPage(req, resp, {path: 'app.html', status: 200, config: {}, googleTagManager: true});
    }));

    this.app.post('/welcome/:page', ...middleware, expressWrap(async (req, resp, next) => {
      const mreq = req as RequestWithLogin;
      const userId = getUserId(req);
      const domain = mreq.org;
      let redirectPath: string = '/';

      if (req.params.page === 'user') {
        const name: string|undefined = req.body && req.body.username || undefined;
        await this.dbManager.updateUser(userId, {name, isFirstTimeUser: false});
        redirectPath = '/welcome/info';

      } else if (req.params.page === 'info') {
        const urlId = DOC_ID_NEW_USER_INFO;
        let body: string|undefined;
        let permitKey: string|undefined;
        try {
          const user = getUser(req);
          const row = {...req.body, UserID: userId, Name: user.name, Email: user.loginEmail};
          body = JSON.stringify(mapValues(row, value => [value]));

          // Take an extra step to translate the special urlId to a docId. This is helpful to
          // allow the same urlId to be used in production and in test. We need the docId for the
          // specialPermit below, which we need to be able to write to this doc.
          //
          // TODO With proper forms support, we could give an origin-based permission to submit a
          // form to this doc, and do it from the client directly.
          const previewerUserId = this.dbManager.getPreviewerUserId();
          const docAuth = await this.dbManager.getDocAuthCached({urlId, userId: previewerUserId});
          const docId = docAuth.docId;
          if (!docId) {
            throw new Error(`Can't resolve ${urlId}: ${docAuth.error}`);
          }

          permitKey = await this._docWorkerMap.setPermit({docId});
          const res = await fetch(await this.getHomeUrlByDocId(docId, `/api/docs/${docId}/tables/Responses/data`), {
            method: 'POST',
            headers: {'Permit': permitKey, 'Content-Type': 'application/json'},
            body,
          });
          if (res.status !== 200) {
            throw new Error(`API call failed with ${res.status}`);
          }
        } catch (e) {
          // If we failed to record, at least log the data, so we could potentially recover it.
          log.rawWarn(`Failed to record new user info: ${e.message}`, {newUserQuestions: body});
        } finally {
          if (permitKey) {
            await this._docWorkerMap.removePermit(permitKey);
          }
        }

        // redirect to teams page if users has access to more than one org. Otherwise redirect to
        // personal org.
        const result = await this.dbManager.getMergedOrgs(userId, userId, domain || null);
        const orgs = (result.status === 200) ? result.data : null;
        if (orgs && orgs.length > 1) {
          redirectPath = '/welcome/teams';
        }
      }

      const mergedOrgDomain = this.dbManager.mergedOrgDomain();
      const redirectUrl = this._getOrgRedirectUrl(mreq, mergedOrgDomain, redirectPath);
      resp.json({redirectUrl});
    }),
    // Add a final error handler that reports errors as JSON.
    jsonErrorHandler);
  }

  public finalize() {
    this.addApiErrorHandlers();

    // add a final non-found handler for other content.
    this.app.use("/", expressWrap((req, resp) => {
      if (this._sendAppPage) {
        return this._sendAppPage(req, resp, {path: 'error.html', status: 404, config: {errPage: 'not-found'}});
      } else {
        return resp.status(404).json({error: 'not found'});
      }
    }));

    // add a final error handler
    this.app.use(async (err: any, req: express.Request, resp: express.Response, next: express.NextFunction) => {
      // Delegate to default error handler when headers have already been sent, as express advises
      // at https://expressjs.com/en/guide/error-handling.html#the-default-error-handler.
      // Also delegates if no _sendAppPage method has been configured.
      if (resp.headersSent || !this._sendAppPage) { return next(err); }
      try {
        const errPage = (
          err.status === 403 ? 'access-denied' :
          err.status === 404 ? 'not-found' :
          'other-error'
        );
        const config = {errPage, errMessage: err.message || err};
        await this._sendAppPage(req, resp, {path: 'error.html', status: err.status || 400, config});
      } catch (err) {
        return next(err);
      }
    });
  }

  public summary() {
    for (const [label, value] of this.info) {
      log.info("== %s: %s", label, value);
    }
  }

  public async start() {
    if (this._check('start')) { return; }

    const servers = this._createServers();
    this.server = servers.server;
    this.httpsServer = servers.httpsServer;
    await this._startServers(this.server, this.httpsServer, this.name, this.port, true);
  }

  public addNotifier() {
    if (this._check('notifier', 'start', 'homedb')) { return; }
    // TODO: Disable notifications for Nioxus orgs, until they are ready to deal with them.
    // TODO: make Notifier aware of base domains, rather than sending emails with default
    // base domain.
    // Most notifications are ultimately triggered by requests with a base domain in them,
    // and all that is needed is a refactor to pass that info along.  But there is also the
    // case of notification(s) from stripe.  May need to associate a preferred base domain
    // with org/user and persist that?
    this.notifier = this.create.Notifier(this.dbManager, this);
  }

  public getGristConfig(): GristLoadConfig {
    return makeGristConfig(this.getDefaultHomeUrl(), {}, this._defaultBaseDomain);
  }

  /**
   * Get a url for a document.  The id provided should be a genuine docId, since we query
   * the db for document details without including organization disambiguation.
   */
  public async getDocUrl(docId: string): Promise<string> {
    if (!this.dbManager) { throw new Error('database missing'); }
    const doc = await this.dbManager.getDoc({
      userId: this.dbManager.getPreviewerUserId(),
      urlId: docId,
      showAll: true
    });
    return this.getResourceUrl(doc);
  }

  /**
   * Get a url for an organization, workspace, or document.
   */
  public async getResourceUrl(resource: Organization|Workspace|Document): Promise<string> {
    if (!this.dbManager) { throw new Error('database missing'); }
    const gristConfig = this.getGristConfig();
    const state: IGristUrlState = {};
    let org: Organization;
    if (resource instanceof Organization) {
      org = resource;
    } else if (resource instanceof Workspace) {
      org = resource.org;
      state.ws = resource.id;
    } else {
      org = resource.workspace.org;
      state.doc = resource.id;
      state.slug = getSlugIfNeeded(resource);
    }
    state.org = this.dbManager.normalizeOrgDomain(org.id, org.domain, org.ownerId);
    if (!gristConfig.homeUrl) { throw new Error('Computing a resource URL requires a home URL'); }
    return encodeUrl(gristConfig, state, new URL(gristConfig.homeUrl));
  }

  public addUsage() {
    if (this._check('usage', 'start', 'homedb')) { return; }
    this.usage = new Usage(this.dbManager);
  }

  public async addHousekeeper() {
    if (this._check('housekeeper', 'start', 'homedb', 'map', 'json', 'api-mw')) { return; }
    const store = this._docWorkerMap;
    this.housekeeper = new Housekeeper(this.dbManager, this, store, store);
    this.housekeeper.addEndpoints(this.app);
    await this.housekeeper.start();
  }

  public async startCopy(name2: string, port2: number) {
    const servers = this._createServers();
    await this._startServers(servers.server, servers.httpsServer, name2, port2, true);
  }

  /**
   * Close all documents currently held open.
   */
  public async closeDocs(): Promise<void> {
    if (this._docManager) {
      return this._docManager.shutdownAll();
    }
  }

  // Adds endpoints that support imports and exports.
  private addSupportPaths(docAccessMiddleware: express.RequestHandler[]) {
    if (!this._docWorker) { throw new Error("need DocWorker"); }

    this.app.get('/download', ...docAccessMiddleware, expressWrap(async (req, res) => {
      // Forward this endpoint to regular API.  This endpoint is now deprecated.
      const docId = String(req.query.doc);
      let url = await this.getHomeUrlByDocId(docId, addOrgToPath(req, `/api/docs/${docId}/download`));
      if (req.query.template === '1') { url += '?template=1'; }
      return res.redirect(url);
    }));

    const basicMiddleware = [this._userIdMiddleware, this.tagChecker.requireTag];

    // Add the handling for the /upload route. Most uploads are meant for a DocWorker: they are put
    // in temporary files, and the DocWorker needs to be on the same machine to have access to them.
    // This doesn't check for doc access permissions because the request isn't tied to a document.
    addUploadRoute(this, this.app, this._trustOriginsMiddleware, ...basicMiddleware);

    this.app.get('/gen_csv', ...docAccessMiddleware, expressWrap(async (req, res) => {
      return this._docWorker.getCSV(req, res);
    }));

    this.app.get('/attachment', ...docAccessMiddleware,
      expressWrap(async (req, res) => this._docWorker.getAttachment(req, res)));
  }

  private _check(part: string, ...precedents: Array<string|null>) {
    if (this.deps.has(part)) { return true; }
    for (const precedent of precedents) {
      if (!precedent) { continue; }
      if (precedent[0] === '!') {
        const antecedent = precedent.slice(1);
        if (this._has(antecedent)) {
          throw new Error(`${part} is needed before ${antecedent}`);
        }
      } else if (!this._has(precedent)) {
        throw new Error(`${precedent} is needed before ${part}`);
      }
    }
    this.deps.add(part);
    return false;
  }

  private _has(part: string) {
    return this.deps.has(part);
  }

  private async _addSelfAsWorker(workers: IDocWorkerMap): Promise<string> {
    try {
      this._healthy = true;
      // Check if this is the first time calling this method.  In production,
      // it always will be.  In testing, we may disconnect and reconnect the
      // worker.  We only need to determine docWorkerId and this.worker once.
      if (!this.worker) {

        if (process.env.GRIST_ROUTER_URL) {
          // register ourselves with the load balancer first.
          const w = await this.createWorkerUrl();
          const url = `${w.url}/v/${this.tag}/`;
          // TODO: we could compute a distinct internal url here.
          this.worker = {
            id: w.host,
            publicUrl: url,
            internalUrl: url,
          };
        } else {
          const url = (process.env.APP_DOC_URL || this.getOwnUrl()) + `/v/${this.tag}/`;
          this.worker = {
            // The worker id should be unique to this worker.
            id: process.env.GRIST_DOC_WORKER_ID || `testDocWorkerId_${this.port}`,
            publicUrl: url,
            internalUrl: process.env.APP_DOC_INTERNAL_URL || url,
          };
        }
        this.info.push(['docWorkerId', this.worker.id]);

        if (process.env.GRIST_WORKER_GROUP) {
          this.worker.group = process.env.GRIST_WORKER_GROUP;
        }
      } else {
        if (process.env.GRIST_ROUTER_URL) {
          await this.createWorkerUrl();
        }
      }
      await workers.addWorker(this.worker);
      await workers.setWorkerAvailability(this.worker.id, true);
    } catch (err) {
      this._healthy = false;
      throw err;
    }
    return this.worker.id;
  }

  private async _removeSelfAsWorker(workers: IDocWorkerMap, docWorkerId: string) {
    this._healthy = false;
    await workers.removeWorker(docWorkerId);
    if (process.env.GRIST_ROUTER_URL) {
      await axios.get(process.env.GRIST_ROUTER_URL,
                      {params: {act: 'remove', port: this.getOwnPort()}});
      log.info(`DocWorker unregistered itself via ${process.env.GRIST_ROUTER_URL}`);
    }
  }

  // Called when server is shutting down.  Save any state that needs saving, and
  // disentangle ourselves from outside world.
  private async _shutdown(): Promise<void> {
    if (!this.worker) { return; }
    if (!this._storageManager) { return; }
    if (!this._docWorkerMap) { return; }  // but this should never happen.

    const workers = this._docWorkerMap;

    // Pick up the pace on saving documents.
    this._storageManager.prepareToCloseStorage();

    // We urgently want to disable any new assignments.
    await workers.setWorkerAvailability(this.worker.id, false);

    // Enumerate the documents we are responsible for.
    let assignments = await workers.getAssignments(this.worker.id);
    let retries: number = 0;
    while (assignments.length > 0 && retries < 3) {
      await Promise.all(assignments.map(async assignment => {
        log.info("FlexServer shutdown assignment", assignment);
        try {
        // Start sending the doc to S3 if needed.
          const flushOp = this._storageManager.closeDocument(assignment);

          // Get access to the clients of this document.  This has the side
          // effect of waiting for the ActiveDoc to finish initialization.
          // This could include loading it from S3, an operation we could
          // potentially abort as an optimization.
          // TODO: abort any s3 loading as an optimization.
          const docPromise = this._docManager.getActiveDoc(assignment);
          const doc = docPromise && await docPromise;

          await flushOp;
          // At this instant, S3 and local document should be the same.

          // We'd now like to make sure (synchronously) that:
          //  - we never output anything new to S3 about this document.
          //  - we never output anything new to user about this document.
          // There could be asynchronous operations going on related to
          // these documents, but if we can make sure that their effects
          // do not reach the outside world then we can ignore them.
          if (doc) {
            doc.docClients.interruptAllClients();
            doc.setMuted();
          }

          // Release this document for other workers to pick up.
          // There is a small window of time here in which a client
          // could reconnect to us.  The muted ActiveDoc will result
          // in them being dropped again.
          await workers.releaseAssignment(this.worker.id, assignment);
        } catch (err) {
          log.info("problem dealing with assignment", assignment, err);
        }
      }));
      // Check for any assignments that slipped through at the last minute.
      assignments = await workers.getAssignments(this.worker.id);
      retries++;
    }
    if (assignments.length > 0) {
      log.error("FlexServer shutdown failed to release assignments:", assignments);
    }

    await this._removeSelfAsWorker(workers, this.worker.id);
    try {
      await this._docManager.shutdownAll();
    } catch (err) {
      log.error("FlexServer shutdown problem", err);
    }
    if (this.comm) {
      this.comm.destroyAllClients();
    }
    log.info("FlexServer shutdown is complete");
  }

  /**
   * Middleware that redirects a request with a userId but without an org to an org-specific URL,
   * after looking up the first org for this userId in DB.
   */
  private async _redirectToOrg(req: express.Request, resp: express.Response, next: express.NextFunction) {
    const mreq = req as RequestWithLogin;
    if (mreq.org || !mreq.userId || !mreq.userIsAuthorized) { return next(); }

    // We have a userId, but the request is for an unknown org. Redirect to an org that's
    // available to the user. This matters in dev, and in prod when visiting a generic URL, which
    // will here redirect to e.g. the user's personal org.
    const result = await this.dbManager.getMergedOrgs(mreq.userId, mreq.userId, null);
    const orgs = (result.status === 200) ? result.data : null;
    const subdomain = orgs && orgs.length > 0 ? orgs[0].domain : null;
    const redirectUrl = subdomain && this._getOrgRedirectUrl(mreq, subdomain);
    if (redirectUrl) {
      log.debug(`Redirecting userId ${mreq.userId} to: ${redirectUrl}`);
      return resp.redirect(redirectUrl);
    }
    next();
  }

  /**
   * Given a Request and a desired subdomain, returns a URL for a similar request that specifies that
   * subdomain either in the hostname or in the path. Optionally passing pathname overrides url's
   * path.
   */
  private _getOrgRedirectUrl(req: RequestWithLogin, subdomain: string, pathname: string = req.originalUrl): string {
    const {hostname, orgInPath} = getOrgUrlInfo(subdomain, req.hostname, {
      org: req.org,
      baseDomain: this._defaultBaseDomain,
      pluginUrl: this._pluginUrl,
      singleOrg: process.env.GRIST_SINGLE_ORG,
    });
    const redirectUrl = new URL(pathname, `${req.protocol}://${req.get('host')}`);
    if (hostname) {
      redirectUrl.hostname = hostname;
    }
    if (orgInPath) {
      redirectUrl.pathname = `/o/${orgInPath}` + redirectUrl.pathname;
    }
    return redirectUrl.href;
  }


  // Create and initialize the plugin manager
  private async _addPluginManager() {
    if (this._pluginManager) { return this._pluginManager; }
    // Only used as {userRoot}/plugins as a place for plugins in addition to {appRoot}/plugins
    const userRoot = path.resolve(process.env.GRIST_USER_ROOT || getAppPathTo(this.appRoot, '.grist'));
    this.info.push(['userRoot', userRoot]);

    const pluginManager = new PluginManager(this.appRoot, userRoot);
    // `initialize()` is asynchronous and reads plugins manifests; if PluginManager is used before it
    // finishes, it will act as if there are no plugins.
    // ^ I think this comment was here to justify calling initialize without waiting for
    // the result.  I'm just going to wait, for determinism.
    await pluginManager.initialize();
    this._pluginManager = pluginManager;
    return pluginManager;
  }

  // Serve the static app.html proxied for a document.
  private _serveDocPage() {
    // Serve the static app.html file.
    // TODO: We should be the ones to fill in the base href here to ensure that the browser fetches
    // the correct version of static files for this app.html.
    this.app.get('/:docId/app.html', this._userIdMiddleware, expressWrap(async (req, res) => {
      const page = await fse.readFile(path.join(getAppPathTo(this.appRoot, 'static'),
                                                'app.html'), 'utf8');
      res.json({
        page,
        tag: this.tag
      });
    }));
  }

  private _getBilling(): IBilling {
    if (!this._billing) {
      if (!this.dbManager) { throw new Error("need dbManager"); }
      this._billing = this.create.Billing(this.dbManager);
    }
    return this._billing;
  }

  // Check whether logger should skip a line.  Careful, req and res are morgan-specific
  // types, not Express.
  private _shouldSkipRequestLogging(req: {url: string}, res: {statusCode: number}) {
    if (req.url === '/status' && [200, 304].includes(res.statusCode) &&
        this._healthCheckCounter > HEALTH_CHECK_LOG_SHOW_FIRST_N &&
        this._healthCheckCounter % HEALTH_CHECK_LOG_SHOW_EVERY_N !== 1) {
      return true;
    }
    return false;
  }

  private _createServers() {
    // Start the app.
    const server = configServer(http.createServer(this.app));
    let httpsServer;
    if (TEST_HTTPS_OFFSET) {
      const certFile = process.env.GRIST_TEST_SSL_CERT;
      const privateKeyFile = process.env.GRIST_TEST_SSL_KEY;
      if (!certFile) { throw new Error('Set GRIST_TEST_SSL_CERT to location of certificate file'); }
      if (!privateKeyFile) { throw new Error('Set GRIST_TEST_SSL_KEY to location of private key file'); }
      log.debug(`https support: reading cert from ${certFile}`);
      log.debug(`https support: reading private key from ${privateKeyFile}`);
      httpsServer = configServer(https.createServer({
        key: fse.readFileSync(privateKeyFile, 'utf8'),
        cert: fse.readFileSync(certFile, 'utf8'),
      }, this.app));
    }
    return {server, httpsServer};
  }

  private async _startServers(server: http.Server, httpsServer: https.Server|undefined,
                              name: string, port: number, verbose: boolean) {
    await new Promise((resolve, reject) => server.listen(port, this.host, resolve).on('error', reject));
    if (verbose) { log.info(`${name} available at ${this.host}:${port}`); }
    if (TEST_HTTPS_OFFSET && httpsServer) {
      const httpsPort = port + TEST_HTTPS_OFFSET;
      await new Promise((resolve, reject) => {
        httpsServer.listen(httpsPort, this.host, resolve)
          .on('error', reject);
      });
      if (verbose) { log.info(`${name} available at https://${this.host}:${httpsPort}`); }
    }
  }
}

/**
 * Returns the passed-in server, with some options adjusted. Specifically, removes the default
 * socket timeout.
 */
function configServer<T extends https.Server|http.Server>(server: T): T {
  // Remove the socket timeout, which causes node to close socket for long-running requests
  // (like imports), triggering browser retry. (The default is 2 min; removed starting node v13.)
  // See also https://nodejs.org/docs/latest-v10.x/api/http.html#http_server_settimeout_msecs_callback.)
  server.setTimeout(0);

  // The server's keepAlive timeout should be longer than the load-balancer's. Otherwise LB will
  // produce occasional 502 errors when it sends a request to node just as node closes a
  // connection. See https://adamcrowder.net/posts/node-express-api-and-aws-alb-502/.
  const lbTimeoutSec = 300;

  // Ensure all inactive connections are terminated by the ALB, by setting this a few seconds
  // higher than the ALB idle timeout
  server.keepAliveTimeout = (lbTimeoutSec + 5) * 1000;

  // Ensure the headersTimeout is set higher than the keepAliveTimeout due to this nodejs
  // regression bug: https://github.com/nodejs/node/issues/27363
  server.headersTimeout = (lbTimeoutSec + 6) * 1000;

  log.info("Server timeouts: keepAliveTimeout %s headersTimeout %s",
    server.keepAliveTimeout, server.headersTimeout);

  return server;
}

// Returns true if environment is configured to allow unauthenticated test logins.
function allowTestLogin() {
  return Boolean(process.env.GRIST_TEST_LOGIN);
}

// Check OPTIONS requests for allowed origins, and return heads to allow the browser to proceed
// with a POST (or other method) request.
function trustOriginHandler(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (trustOrigin(req, res)) {
    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Methods", "GET, PATCH, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Requested-With");
  } else {
    throw new Error('Unrecognized origin');
  }
  if ('OPTIONS' === req.method) {
    res.sendStatus(200);
  } else {
    next();
  }
}

// Set Cache-Control header to "no-cache"
function noCaching(req: express.Request, res: express.Response, next: express.NextFunction) {
  res.header("Cache-Control", "no-cache");
  next();
}

// Methods that Electron app relies on.
export interface ElectronServerMethods {
  importDoc(filepath: string): Promise<DocCreationInfo>;
  onDocOpen(cb: () => void): void;
  getUserConfig(): Promise<any>;
  updateUserConfig(obj: any): Promise<void>;
  onBackupMade(cb: () => void): void;
}
