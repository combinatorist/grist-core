import {get as getBrowserGlobals} from 'app/client/lib/browserGlobals';
import {guessTimezone} from 'app/client/lib/guessTimezone';
import {getWorker} from 'app/client/models/gristConfigCache';
import * as gutil from 'app/common/gutil';
import {addOrgToPath, docUrl, getGristConfig} from 'app/common/urlUtils';
import {UserAPI, UserAPIImpl} from 'app/common/UserAPI';
import {Events as BackboneEvents} from 'backbone';
import {Disposable} from 'grainjs';

const G = getBrowserGlobals('window');
const reconnectInterval = [1000, 1000, 2000, 5000, 10000];

// Time that may elapse prior to triggering a heartbeat message.  This is a message
// sent in order to keep the websocket from being closed by an intermediate load
// balancer.
const HEARTBEAT_PERIOD_IN_SECONDS = 45;

// Find the correct worker to connect to for the currently viewed doc,
// returning a base url for endpoints served by that worker.  The url
// may need to change again in future.
async function getDocWorkerUrl(assignmentId: string|null): Promise<string|null> {
  // Currently, a null assignmentId happens only in classic Grist, where the server
  // never changes.
  if (assignmentId === null) { return docUrl(null); }

  const api: UserAPI = new UserAPIImpl(getGristConfig().homeUrl!);
  return getWorker(api, assignmentId);
}

/**
 * Settings for the Grist websocket connection.  Includes timezone, urls, and client id,
 * and various services needed for the connection.
 */
export interface GristWSSettings {
  // A factory function for creating the WebSocket so that we can use from node
  // or browser.
  makeWebSocket(url: string): WebSocket;

  // A function for getting the timezone, so the code can be used outside webpack -
  // currently a timezone library is lazy loaded in a way that doesn't quite work
  // with ts-node.
  getTimezone(): Promise<string>;

  // Get the page url - this is how the organization is currently determined.
  getPageUrl(): string;

  // Get the URL for the worker serving the given assignmentId (which is usually a docId).
  getDocWorkerUrl(assignmentId: string|null): Promise<string|null>;

  // Get an id associated with the client, null for "no id set yet".
  getClientId(assignmentId: string|null): string|null;

  // Get selector for user, so if cookie auth allows multiple the correct one will be picked.
  // Selector is currently just the email address.
  getUserSelector(): string;

  // Update the id associated with the client.  Future calls to getClientId should return this.
  updateClientId(assignmentId: string|null, clentId: string): void;

  // Returns the next identifier for a new GristWSConnection object, and advance the counter.
  advanceCounter(): string;

  // Called with messages to log.
  log(...args: any[]): void;
  warn(...args: any[]): void;
}

/**
 * An implementation of Grist websocket connection settings for the browser.
 */
export class GristWSSettingsBrowser implements GristWSSettings {
  public makeWebSocket(url: string) { return new WebSocket(url); }
  public getTimezone()              { return guessTimezone(); }
  public getPageUrl()               { return G.window.location.href; }
  public async getDocWorkerUrl(assignmentId: string|null) {
    return getDocWorkerUrl(assignmentId);
  }
  public getClientId(assignmentId: string|null) {
    return window.sessionStorage.getItem(`clientId_${assignmentId}`) || null;
  }
  public getUserSelector(): string {
    // TODO: find/create a more official way to get the user.
    return (window as any).gristDocPageModel?.appModel.currentUser?.email || '';
  }
  public updateClientId(assignmentId: string|null, id: string) {
    window.sessionStorage.setItem(`clientId_${assignmentId}`, id);
  }
  public advanceCounter(): string {
    const value = parseInt(window.sessionStorage.getItem('clientCounter')!, 10) || 0;
    window.sessionStorage.setItem('clientCounter', String(value + 1));
    return String(value);
  }
  public log(...args: any[]): void {
    console.log(...args);   // tslint:disable-line:no-console
  }
  public warn(...args: any[]): void {
    console.warn(...args);  // tslint:disable-line:no-console
  }
}

/**
 * GristWSConnection establishes a connection to the server and keep reconnecting
 * in the event that it loses the connection.
 */
export class GristWSConnection extends Disposable {
  public useCount: number = 0;
  public on: BackboneEvents['on'];    // set by Backbone

  private _clientId: string|null;
  private _clientCounter: string;     // Identifier of this GristWSConnection object in this browser tab session
  private _assignmentId: string|null;
  private _docWorkerUrl: string|null = null;
  private _initialConnection: Promise<void>;
  private _established: boolean = false;     // This is set once the server sends us a 'clientConnect' message.
  private _firstConnect: boolean = true;
  private _heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private _reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private _reconnectAttempts: number = 0;
  private _wantReconnect: boolean = true;
  private _ws: WebSocket|null = null;
  private trigger: BackboneEvents['trigger']; // set by Backbone

  constructor(private _settings: GristWSSettings = new GristWSSettingsBrowser()) {
    super();
    this._clientCounter = _settings.advanceCounter();
    this.onDispose(() => this.disconnect());
  }

  public initialize(assignmentId: string|null) {
    // For reconnections, squirrel away the id of the resource we are committed to (if any).
    this._assignmentId = assignmentId;
    // clientId is associated with a session. We try to persist it within a tab across navigation
    // and reloads, but the server may reset it if it doesn't recognize it.
    this._clientId = this._settings.getClientId(assignmentId);
    // For the DocMenu, identified as a page served with a homeUrl but no getWorker cache, we will
    // simply not hook up the websocket.  The client is not ready to use it, and the server is not
    // ready to serve it.  And the errors in the logs of both are distracting.  However, it
    // doesn't really make sense to rip out the websocket code entirely, since the plan is
    // to eventually bring it back for smoother serving.  Hence this compromise of simply
    // not trying to make the connection.
    // TODO: serve and use websockets for the DocMenu.
    if (getGristConfig().getWorker) {
      this.trigger('connectState', false);
      this._initialConnection = this.connect();
    } else {
      this._log("GristWSConnection not activating for hosted grist page with no document present");
    }
  }

  /**
   * Method that opens a websocket connection and continuously tries to reconnect if the connection
   * is closed.
   * @param isReconnecting - Flag set when attempting to reconnect
   */
  public async connect(isReconnecting: boolean = false): Promise<void> {
    await this._updateDocWorkerUrl();
    this._wantReconnect = true;
    this._connectImpl(isReconnecting, await this._settings.getTimezone());
  }

  // Disconnect websocket if currently connected, and reset to initial state.
  public disconnect() {
    this._log('GristWSConnection: disconnect');
    this._wantReconnect = false;
    this._established = false;
    if (this._ws) {
      this._ws.close();
      this._ws = null;
      this._clientId = null;
    }
    this._clearHeartbeat();
    if (this._reconnectTimeout) {
      clearTimeout(this._reconnectTimeout);
    }
    this._firstConnect = true;
    this._reconnectAttempts = 0;
  }

  public get established(): boolean {
    return this._established;
  }

  public get clientId(): string|null {
    return this._clientId;
  }

  /**
   * Returns the URL of the doc worker, or throws if we don't have one.
   */
  public get docWorkerUrl(): string {
    if (!this._docWorkerUrl) { throw new Error('server for document not known'); }
    return this._docWorkerUrl;
  }

  /**
   * Returns the URL of the doc worker, or null if we don't have one.
   */
  public getDocWorkerUrlOrNull(): string | null {
    return this._docWorkerUrl;
  }

  /**
   * @event serverMessage Triggered when a message arrives from the server. Callbacks receive
   *    the raw message data as an additional argument.
   */
  public onmessage(ev: any) {
    this._log('GristWSConnection: onmessage (%d bytes)', ev.data.length);
    this._scheduleHeartbeat();
    const message = JSON.parse(ev.data);

    // clientConnect is the first message from the server that sets the clientId. We only consider
    // the connection established once we receive it.
    if (message.type === 'clientConnect') {
      if (this._established) {
        this._log("GristWSConnection skipping duplicate 'clientConnect' message");
        return;
      }
      this._established = true;
      // Add a flag to the message to indicate if the active session changed, and warrants a reload.
      message.resetClientId = (message.clientId !== this._clientId && !this._firstConnect);
      this._log(`GristWSConnection established: clientId ${message.clientId} counter ${this._clientCounter}` +
                ` resetClientId ${message.resetClientId}`);
      if (message.dup) {
        this._warn("GristWSConnection missed initial 'clientConnect', processing its duplicate");
      }
      if (message.clientId !== this._clientId) {
        this._clientId = message.clientId;
        if (this._settings) {
          this._settings.updateClientId(this._assignmentId, message.clientId);
        }
      }
      this._firstConnect = false;
      this.trigger('connectState', true);

      // Process any missed messages. (Should only have any if resetClientId is false.)
      for (const msg of message.missedMessages) {
        this.trigger('serverMessage', JSON.parse(msg));
      }
    }
    if (!this._established) {
      this._log("GristWSConnection not yet established; ignoring message", message);
      return;
    }
    this.trigger('serverMessage', message);
  }

  public send(message: any) {
    this._log(`GristWSConnection.send[${this.established}]`, message);
    if (!this._established) {
      return false;
    }
    this._ws!.send(message);
    this._scheduleHeartbeat();
    return true;
  }

  // unschedule any pending heartbeat message
  private _clearHeartbeat() {
    if (this._heartbeatTimeout) {
      clearTimeout(this._heartbeatTimeout);
      this._heartbeatTimeout = null;
    }
  }

  // schedule a heartbeat message for HEARTBEAT_PERIOD_IN_SECONDS seconds from now
  private _scheduleHeartbeat() {
    this._clearHeartbeat();
    this._heartbeatTimeout = setTimeout(this._sendHeartbeat.bind(this),
                                        Math.round(HEARTBEAT_PERIOD_IN_SECONDS * 1000));
  }

  // send a heartbeat message, including the document url for server-side logs
  private _sendHeartbeat() {
    this.send(JSON.stringify({
      beat: 'alive',
      url: G.window.location.href,
      docId: this._assignmentId,
    }));
  }

  private _connectImpl(isReconnecting: boolean, timezone: any) {

    if (!this._wantReconnect) { return; }

    if (isReconnecting) {
      this._reconnectAttempts++;
    }

    // Note that if a WebSocket can't establish a connection it will trigger onclose()
    // As per http://dev.w3.org/html5/websockets/
    // "If the establish a WebSocket connection algorithm fails,
    // it triggers the fail the WebSocket connection algorithm,
    // which then invokes the close the WebSocket connection algorithm,
    // which then establishes that the WebSocket connection is closed,
    // which fires the close event."
    const url = this._buildWebsocketUrl(isReconnecting, timezone);
    this._log("GristWSConnection connecting to: " + url);
    this._ws = this._settings.makeWebSocket(url);

    this._ws.onopen = () => {
      const connectMessage = isReconnecting ? 'Reconnected' : 'Connected';
      this._log('GristWSConnection: onopen: ' + connectMessage);

      this.trigger('connectionStatus', connectMessage, 'OK');
      this._reconnectAttempts = 0; // reset reconnection information
      this._scheduleHeartbeat();
    };

    this._ws.onmessage = this.onmessage.bind(this);

    this._ws.onerror = (ev: Event) => {
      this._log('GristWSConnection: onerror', ev);
    };

    this._ws.onclose = () => {
      if (this._settings) {
        this._log('GristWSConnection: onclose');
      }
      if (this.isDisposed()) {
        return;
      }

      this._established = false;
      this._ws = null;
      this.trigger('connectState', false);

      if (!this._wantReconnect) { return; }
      const reconnectTimeout = gutil.getReconnectTimeout(this._reconnectAttempts, reconnectInterval);
      this._log("Trying to reconnect in", reconnectTimeout, "ms");
      this.trigger('connectionStatus', 'Trying to reconnect...', 'WARNING');
      this._reconnectTimeout = setTimeout(async () => {
        this._reconnectTimeout = null;
        // Make sure we've gotten through all lazy-loading.
        await this._initialConnection;
        await this.connect(true);
      }, reconnectTimeout);
    };
  }

  private _buildWebsocketUrl(isReconnecting: boolean, timezone: any): string {
    const url = new URL(this.docWorkerUrl);
    url.protocol = (url.protocol === 'https:') ? 'wss:' : 'ws:';
    url.searchParams.append('clientId', this._clientId || '0');
    url.searchParams.append('counter', this._clientCounter);
    url.searchParams.append('newClient', String(isReconnecting ? 0 : 1));
    url.searchParams.append('browserSettings', JSON.stringify({timezone}));
    url.searchParams.append('user', this._settings.getUserSelector());
    return url.href;
  }

  private async _updateDocWorkerUrl() {
    try {
      const url: string|null = await this._settings.getDocWorkerUrl(this._assignmentId);
      // Doc worker urls in general will need to have org information in them, since
      // the doc worker will check for that.  The home service doesn't currently do
      // that for us, although it could.  TODO: update home server to produce
      // standalone doc worker urls.
      this._docWorkerUrl = url ? addOrgToPath(url, this._settings.getPageUrl()) : url;
    } catch (e) {
      this._warn('Failed to connect to server for document');
    }
  }

  // Log a message using the configured logger, or send it to console if no
  // logger available.
  private _log(...args: any[]): void {
    if (!this._settings) {
      // tslint:disable-next-line:no-console
      console.warn('log called without settings in GristWSConnection');
      console.log(...args);   // tslint:disable-line:no-console
    } else {
      this._settings.log(...args);
    }
  }

  // Log a warning using the configured logger, or send it to console if no
  // logger available.
  private _warn(...args: any[]): void {
    if (!this._settings) {
      // tslint:disable-next-line:no-console
      console.warn('warn called without settings in GristWSConnection');
      console.warn(...args);   // tslint:disable-line:no-console
    } else {
      this._settings.warn(...args);
    }
  }
}

Object.assign(GristWSConnection.prototype, BackboneEvents);
