import { createEmptyActionSummary } from "app/common/ActionSummary";
import { ApiError } from 'app/common/ApiError';
import { BrowserSettings } from "app/common/BrowserSettings";
import { fromTableDataAction, TableColValues } from 'app/common/DocActions';
import { arrayRepeat, isAffirmative } from "app/common/gutil";
import { SortFunc } from 'app/common/SortFunc';
import { DocReplacementOptions, DocState, DocStateComparison, DocStates, NEW_DOCUMENT_CODE} from 'app/common/UserAPI';
import { HomeDBManager, makeDocAuthResult } from 'app/gen-server/lib/HomeDBManager';
import { concatenateSummaries, summarizeAction } from "app/server/lib/ActionSummary";
import { ActiveDoc } from "app/server/lib/ActiveDoc";
import { assertAccess, getOrSetDocAuth, getTransitiveHeaders, getUserId, isAnonymousUser,
         RequestWithLogin } from 'app/server/lib/Authorizer';
import { DocManager } from "app/server/lib/DocManager";
import { docSessionFromRequest, makeExceptionalDocSession, OptDocSession } from "app/server/lib/DocSession";
import { DocWorker } from "app/server/lib/DocWorker";
import { IDocWorkerMap } from "app/server/lib/DocWorkerMap";
import { expressWrap } from 'app/server/lib/expressWrap';
import { filterDocumentInPlace } from "app/server/lib/filterUtils";
import { GristServer } from 'app/server/lib/GristServer';
import { HashUtil } from 'app/server/lib/HashUtil';
import { makeForkIds } from "app/server/lib/idUtils";
import {
  getDocId, getDocScope, integerParam, isParameterOn, optStringParam,
  sendOkReply, sendReply, stringParam } from 'app/server/lib/requestUtils';
import { SandboxError } from "app/server/lib/sandboxUtil";
import { handleOptionalUpload, handleUpload } from "app/server/lib/uploads";
import * as contentDisposition from 'content-disposition';
import { Application, NextFunction, Request, RequestHandler, Response } from "express";
import fetch from 'node-fetch';
import * as path from 'path';

// Cap on the number of requests that can be outstanding on a single document via the
// rest doc api.  When this limit is exceeded, incoming requests receive an immediate
// reply with status 429.
const MAX_PARALLEL_REQUESTS_PER_DOC = 10;

type WithDocHandler = (activeDoc: ActiveDoc, req: RequestWithLogin, resp: Response) => Promise<void>;

/**
 * Middleware to track the number of requests outstanding on each document, and to
 * throw an exception when the maximum number of requests are already outstanding.
 * Access to a document must already have been authorized.
 */
function apiThrottle(usage: Map<string, number>,
                     callback: (req: RequestWithLogin,
                                resp: Response,
                                next: NextFunction) => void|Promise<void>): RequestHandler {
  return async (req, res, next) => {
    const docId = getDocId(req);
    try {
      const count = usage.get(docId) || 0;
      usage.set(docId, count + 1);
      if (count + 1 > MAX_PARALLEL_REQUESTS_PER_DOC) {
        throw new ApiError(`Too many backlogged requests for document ${docId} - ` +
                           `try again later?`, 429);
      }
      await callback(req as RequestWithLogin, res, next);
    } catch (err) {
      next(err);
    } finally {
      const count = usage.get(docId);
      if (count) {
        if (count === 1) {
          usage.delete(docId);
        } else {
          usage.set(docId, count - 1);
        }
      }
    }
  };
}

export class DocWorkerApi {
  constructor(private _app: Application, private _docWorker: DocWorker,
              private _docWorkerMap: IDocWorkerMap, private _docManager: DocManager,
              private _dbManager: HomeDBManager, private _grist: GristServer) {}

  /**
   * Adds endpoints for the doc api.
   *
   * Note that it expects bodyParser, userId, and jsonErrorHandler middleware to be set up outside
   * to apply to these routes.
   */
  public addEndpoints() {

    // check document exists (not soft deleted) and user can view it
    const canView = expressWrap(this._assertAccess.bind(this, 'viewers', false));
    // check document exists (not soft deleted) and user can edit it
    const canEdit = expressWrap(this._assertAccess.bind(this, 'editors', false));
    const isOwner = expressWrap(this._assertAccess.bind(this, 'owners', false));
    // check user can edit document, with soft-deleted documents being acceptable
    const canEditMaybeRemoved = expressWrap(this._assertAccess.bind(this, 'editors', true));
    // check document exists, don't check user access
    const docExists = expressWrap(this._assertAccess.bind(this, null, false));

    // Middleware to limit number of outstanding requests per document.  Will also
    // handle errors like expressWrap would.
    const throttled = apiThrottle.bind(null, new Map());
    const withDoc = (callback: WithDocHandler) => throttled(this._requireActiveDoc(callback));

    // Apply user actions to a document.
    this._app.post('/api/docs/:docId/apply', canEdit, withDoc(async (activeDoc, req, res) => {
      res.json(await activeDoc.applyUserActions(docSessionFromRequest(req), req.body));
    }));

    // Get the specified table.
    this._app.get('/api/docs/:docId/tables/:tableId/data', canView, withDoc(async (activeDoc, req, res) => {
      const filters = req.query.filter ? JSON.parse(String(req.query.filter)) : {};
      if (!Object.keys(filters).every(col => Array.isArray(filters[col]))) {
        throw new ApiError("Invalid query: filter values must be arrays", 400);
      }
      const tableId = req.params.tableId;
      const tableData = await handleSandboxError(tableId, [], activeDoc.fetchQuery(
        docSessionFromRequest(req), {tableId, filters}, true));
      // Apply sort/limit parameters, if set.  TODO: move sorting/limiting into data engine
      // and sql.
      const params = getQueryParameters(req);
      res.json(applyQueryParameters(fromTableDataAction(tableData), params));
    }));

    // The upload should be a multipart post with an 'upload' field containing one or more files.
    // Returns the list of rowIds for the rows created in the _grist_Attachments table.
    this._app.post('/api/docs/:docId/attachments', canEdit, withDoc(async (activeDoc, req, res) => {
      const uploadResult = await handleUpload(req, res);
      res.json(await activeDoc.addAttachments(docSessionFromRequest(req), uploadResult.uploadId));
    }));

    // Returns the metadata for a given attachment ID (i.e. a rowId in _grist_Attachments table).
    this._app.get('/api/docs/:docId/attachments/:attId', canView, withDoc(async (activeDoc, req, res) => {
      const attRecord = activeDoc.getAttachmentMetadata(req.params.attId as string);
      const {fileName, fileSize, timeUploaded: t} = attRecord;
      const timeUploaded = (typeof t === 'number') ? new Date(t).toISOString() : undefined;
      res.json({fileName, fileSize, timeUploaded});
    }));

    // Responds with attachment contents, with suitable Content-Type and Content-Disposition.
    this._app.get('/api/docs/:docId/attachments/:attId/download', canView, withDoc(async (activeDoc, req, res) => {
      const attRecord = activeDoc.getAttachmentMetadata(req.params.attId as string);
      const fileIdent = attRecord.fileIdent as string;
      const ext = path.extname(fileIdent);
      const origName = attRecord.fileName as string;
      const fileName = ext ? path.basename(origName, path.extname(origName)) + ext : origName;
      const fileData = await activeDoc.getAttachmentData(docSessionFromRequest(req), fileIdent);
      res.status(200)
        .type(ext)
        // Construct a content-disposition header of the form 'attachment; filename="NAME"'
        .set('Content-Disposition', contentDisposition(fileName, {type: 'attachment'}))
        .set('Cache-Control', 'private, max-age=3600')
        .send(fileData);
    }));

    // Adds records.
    this._app.post('/api/docs/:docId/tables/:tableId/data', canEdit, withDoc(async (activeDoc, req, res) => {
      const tableId = req.params.tableId;
      const columnValues = req.body;
      const colNames = Object.keys(columnValues);
      // user actions expect [null, ...] as row ids, first let's figure the number of items to add by
      // looking at the length of a column
      const count = columnValues[colNames[0]].length;
      // then, let's create [null, ...]
      const rowIds = arrayRepeat(count, null);
      const sandboxRes = await handleSandboxError(tableId, colNames, activeDoc.applyUserActions(
        docSessionFromRequest(req),
        [['BulkAddRecord', tableId, rowIds, columnValues]]));
      res.json(sandboxRes.retValues[0]);
    }));

    this._app.post('/api/docs/:docId/tables/:tableId/data/delete', canEdit, withDoc(async (activeDoc, req, res) => {
      const tableId = req.params.tableId;
      const rowIds = req.body;
      const sandboxRes = await handleSandboxError(tableId, [], activeDoc.applyUserActions(
        docSessionFromRequest(req),
        [['BulkRemoveRecord', tableId, rowIds]]));
      res.json(sandboxRes.retValues[0]);
    }));

    // Download full document
    // TODO: look at download behavior if ActiveDoc is shutdown during call (cannot
    // use withDoc wrapper)
    this._app.get('/api/docs/:docId/download', canView, throttled(async (req, res) => {
      // We want to be have a way download broken docs that ActiveDoc may not be able
      // to load.  So, if the user owns the document, we unconditionally let them
      // download.
      if (await this._isOwner(req)) {
        try {
          // We carefully avoid creating an ActiveDoc for the document being downloaded,
          // in case it is broken in some way.  It is convenient to be able to download
          // broken files for diagnosis/recovery.
          return await this._docWorker.downloadDoc(req, res, this._docManager.storageManager);
        } catch (e) {
          if (e.message && e.message.match(/does not exist yet/)) {
            // The document has never been seen on file system / s3.  It may be new, so
            // we try again after having created an ActiveDoc for the document.
            await this._getActiveDoc(req);
            return this._docWorker.downloadDoc(req, res, this._docManager.storageManager);
          } else {
            throw e;
          }
        }
      } else {
        // If the user is not an owner, we load the document as an ActiveDoc, and then
        // check if the user has download permissions.
        const activeDoc = await this._getActiveDoc(req);
        if (!await activeDoc.canDownload(docSessionFromRequest(req))) {
          throw new Error('not authorized to download this document');
        }
        return this._docWorker.downloadDoc(req, res, this._docManager.storageManager);
      }
    }));

    // Fork the specified document.
    this._app.post('/api/docs/:docId/fork', canView, withDoc(async (activeDoc, req, res) => {
      const result = await activeDoc.fork(docSessionFromRequest(req));
      res.json(result);
    }));

    // Initiate a fork.  Used internally to implement ActiveDoc.fork.  Only usable via a Permit.
    this._app.post('/api/docs/:docId/create-fork', canEdit, throttled(async (req, res) => {
      const docId = stringParam(req.params.docId);
      const srcDocId = stringParam(req.body.srcDocId);
      if (srcDocId !== req.specialPermit?.otherDocId) { throw new Error('access denied'); }
      const fname = await this._docManager.storageManager.prepareFork(srcDocId, docId);
      await filterDocumentInPlace(docSessionFromRequest(req), fname);
      res.json({srcDocId, docId});
    }));

    // Update records. The records to update are identified by their id column. Any invalid id fails
    // the request and returns a 400 error code.
    this._app.patch('/api/docs/:docId/tables/:tableId/data', canEdit, withDoc(async (activeDoc, req, res) => {
      const tableId = req.params.tableId;
      const columnValues = req.body;
      const colNames = Object.keys(columnValues);
      const rowIds = columnValues.id;
      // sandbox expects no id column
      delete columnValues.id;
      await handleSandboxError(tableId, colNames, activeDoc.applyUserActions(
        docSessionFromRequest(req),
        [['BulkUpdateRecord', tableId, rowIds, columnValues]]));
      res.json(null);
    }));

    // Reload a document forcibly (in fact this closes the doc, it will be automatically
    // reopened on use).
    this._app.post('/api/docs/:docId/force-reload', canEdit, throttled(async (req, res) => {
      const activeDoc = await this._getActiveDoc(req);
      await activeDoc.reloadDoc();
      res.json(null);
    }));

    this._app.post('/api/docs/:docId/recover', canEdit, throttled(async (req, res) => {
      const recoveryModeRaw = req.body.recoveryMode;
      const recoveryMode = (typeof recoveryModeRaw === 'boolean') ? recoveryModeRaw : undefined;
      if (!await this._isOwner(req)) { throw new Error('Only owners can control recovery mode'); }
      const activeDoc = await this._docManager.fetchDoc(docSessionFromRequest(req), getDocId(req), recoveryMode);
      res.json({
        recoveryMode: activeDoc.recoveryMode
      });
    }));

    // DELETE /api/docs/:docId
    // Delete the specified doc.
    this._app.delete('/api/docs/:docId', canEditMaybeRemoved, throttled(async (req, res) => {
      await this._removeDoc(req, res, true);
    }));

    // POST /api/docs/:docId/remove
    // Soft-delete the specified doc.  If query parameter "permanent" is set,
    // delete permanently.
    this._app.post('/api/docs/:docId/remove', canEditMaybeRemoved, throttled(async (req, res) => {
      await this._removeDoc(req, res, isParameterOn(req.query.permanent));
    }));

    this._app.get('/api/docs/:docId/snapshots', canView, withDoc(async (activeDoc, req, res) => {
      const {snapshots} = await activeDoc.getSnapshots(isAffirmative(req.query.raw));
      res.json({snapshots});
    }));

    this._app.post('/api/docs/:docId/snapshots/remove', isOwner, withDoc(async (activeDoc, req, res) => {
      const docSession = docSessionFromRequest(req);
      const snapshotIds = req.body.snapshotIds as string[];
      if (snapshotIds) {
        await activeDoc.removeSnapshots(docSession, snapshotIds);
        res.json({snapshotIds});
        return;
      }
      if (req.body.select === 'unlisted') {
        // Remove any snapshots not listed in inventory.  Ideally, there should be no
        // snapshots, and this undocument feature is just for fixing up problems.
        const full = (await activeDoc.getSnapshots(true)).snapshots.map(s => s.snapshotId);
        const listed = new Set((await activeDoc.getSnapshots()).snapshots.map(s => s.snapshotId));
        const unlisted = full.filter(snapshotId => !listed.has(snapshotId));
        await activeDoc.removeSnapshots(docSession, unlisted);
        res.json({snapshotIds: unlisted});
        return;
      }
      if (req.body.select === 'past') {
        // Remove all but the latest snapshot.  Useful for sanitizing history if something
        // bad snuck into previous snapshots and they are not valuable to preserve.
        const past = (await activeDoc.getSnapshots(true)).snapshots.map(s => s.snapshotId);
        past.shift();  // remove current version.
        await activeDoc.removeSnapshots(docSession, past);
        res.json({snapshotIds: past});
        return;
      }
      throw new Error('please specify snapshotIds to remove');
    }));

    this._app.post('/api/docs/:docId/flush', canEdit, throttled(async (req, res) => {
      const activeDocPromise = this._getActiveDocIfAvailable(req);
      if (!activeDocPromise) {
        // Only need to flush if doc is actually open.
        res.json(false);
        return;
      }
      const activeDoc = await activeDocPromise;
      await activeDoc.flushDoc();
      res.json(true);
    }));

    // Administrative endpoint, that checks if a document is in the expected group,
    // and frees it for reassignment if not.  Has no effect if document is in the
    // expected group.  Does not require specific rights.  Returns true if the document
    // is freed up for reassignment, otherwise false.
    this._app.post('/api/docs/:docId/assign', docExists, throttled(async (req, res) => {
      const docId = getDocId(req);
      const status = await this._docWorkerMap.getDocWorker(docId);
      if (!status) { res.json(false); return; }
      const workerGroup = await this._docWorkerMap.getWorkerGroup(status.docWorker.id);
      const docGroup = await this._docWorkerMap.getDocGroup(docId);
      if (docGroup === workerGroup) { res.json(false); return; }
      const activeDoc = await this._getActiveDoc(req);
      await activeDoc.flushDoc();
      // flushDoc terminates once there's no pending operation on the document.
      // There could still be async operations in progess.  We mute their effect,
      // as if they never happened.
      activeDoc.docClients.interruptAllClients();
      activeDoc.setMuted();
      await activeDoc.shutdown();
      await this._docWorkerMap.releaseAssignment(status.docWorker.id, docId);
      res.json(true);
    }));

    // This endpoint cannot use withDoc since it is expected behavior for the ActiveDoc it
    // starts with to become muted.
    this._app.post('/api/docs/:docId/replace', canEdit, throttled(async (req, res) => {
      const activeDoc = await this._getActiveDoc(req);
      const options: DocReplacementOptions = {};
      if (req.body.sourceDocId) {
        options.sourceDocId = await this._confirmDocIdForRead(req, String(req.body.sourceDocId));
        // We should make sure the source document has flushed recently.
        // It may not be served by the same worker, so work through the api.
        await fetch(this._grist.getHomeUrl(req, `/api/docs/${options.sourceDocId}/flush`), {
          method: 'POST',
          headers: {
            ...getTransitiveHeaders(req),
            'Content-Type': 'application/json',
          }
        });
      }
      if (req.body.snapshotId) {
        options.snapshotId = String(req.body.snapshotId);
      }
      await activeDoc.replace(options);
      res.json(null);
    }));

    this._app.get('/api/docs/:docId/states', canView, withDoc(async (activeDoc, req, res) => {
      const docSession = docSessionFromRequest(req);
      res.json(await this._getStates(docSession, activeDoc));
    }));

    this._app.post('/api/docs/:docId/states/remove', isOwner, withDoc(async (activeDoc, req, res) => {
      const docSession = docSessionFromRequest(req);
      const keep = integerParam(req.body.keep);
      res.json(await activeDoc.deleteActions(docSession, keep));
    }));

    this._app.get('/api/docs/:docId/compare/:docId2', canView, withDoc(async (activeDoc, req, res) => {
      const showDetails = isAffirmative(req.query.detail);
      const docSession = docSessionFromRequest(req);
      const {states} = await this._getStates(docSession, activeDoc);
      const ref = await fetch(this._grist.getHomeUrl(req, `/api/docs/${req.params.docId2}/states`), {
        headers: {
          ...getTransitiveHeaders(req),
          'Content-Type': 'application/json',
        }
      });
      const states2: DocState[] = (await ref.json()).states;
      const left = states[0];
      const right = states2[0];
      if (!left || !right) {
        // This should not arise unless there's a bug.
        throw new Error('document with no history');
      }
      const rightHashes = new Set(states2.map(state => state.h));
      const parent = states.find(state => rightHashes.has(state.h )) || null;
      const leftChanged = parent && parent.h !== left.h;
      const rightChanged = parent && parent.h !== right.h;
      const summary = leftChanged ? (rightChanged ? 'both' : 'left') :
        (rightChanged ? 'right' : (parent ? 'same' : 'unrelated'));
      const comparison: DocStateComparison = {
        left, right, parent, summary
      };
      if (showDetails && parent) {
        // Calculate changes from the parent to the current version of this document.
        const leftChanges = (await this._getChanges(docSession, activeDoc, states, parent.h,
                                                    'HEAD')).details!.rightChanges;

        // Calculate changes from the (common) parent to the current version of the other document.
        const url = `/api/docs/${req.params.docId2}/compare?left=${parent.h}`;
        const rightChangesReq = await fetch(this._grist.getHomeUrl(req, url), {
          headers: {
            ...getTransitiveHeaders(req),
            'Content-Type': 'application/json',
          }
        });
        const rightChanges = (await rightChangesReq.json()).details!.rightChanges;

        // Add the left and right changes as details to the result.
        comparison.details = { leftChanges, rightChanges };
      }
      res.json(comparison);
    }));

    // Give details about what changed between two versions of a document.
    this._app.get('/api/docs/:docId/compare', canView, withDoc(async (activeDoc, req, res) => {
      // This could be a relatively slow operation if actions are large.
      const left = stringParam(req.query.left || 'HEAD');
      const right = stringParam(req.query.right || 'HEAD');
      const docSession = docSessionFromRequest(req);
      const {states} = await this._getStates(docSession, activeDoc);
      res.json(await this._getChanges(docSession, activeDoc, states, left, right));
    }));

    // Do an import targeted at a specific workspace. Although the URL fits ApiServer, this
    // endpoint is handled only by DocWorker, so is handled here. (Note: this does not handle
    // actual file uploads, so no worries here about large request bodies.)
    this._app.post('/api/workspaces/:wid/import', expressWrap(async (req, res) => {
      const userId = getUserId(req);
      const wsId = integerParam(req.params.wid);
      const uploadId = integerParam(req.body.uploadId);
      const result = await this._docManager.importDocToWorkspace(userId, uploadId, wsId, req.body.browserSettings);
      res.json(result);
    }));

    // Create a document.  When an upload is included, it is imported as the initial
    // state of the document.  Otherwise a fresh empty document is created.
    // A "timezone" option can be supplied.
    // Documents are created "unsaved".
    // TODO: support workspaceId option for creating regular documents, at which point
    // existing import endpoint and doc creation endpoint can share implementation
    // with this.
    // Returns the id of the created document.
    this._app.post('/api/docs', expressWrap(async (req, res) => {
      const userId = getUserId(req);
      let uploadId: number|undefined;
      let parameters: {[key: string]: any};
      if (req.is('multipart/form-data')) {
        const formResult = await handleOptionalUpload(req, res);
        if (formResult.upload) {
          uploadId = formResult.upload.uploadId;
        }
        parameters = formResult.parameters || {};
      } else {
        parameters = req.body;
      }
      if (parameters.workspaceId) { throw new Error('workspaceId not supported'); }
      const browserSettings: BrowserSettings = {};
      if (parameters.timezone) { browserSettings.timezone = parameters.timezone; }
      if (uploadId !== undefined) {
        const result = await this._docManager.importDocToWorkspace(userId, uploadId, null,
                                                                   browserSettings);
        return res.json(result.id);
      }
      const isAnonymous = isAnonymousUser(req);
      const {docId} = makeForkIds({userId, isAnonymous, trunkDocId: NEW_DOCUMENT_CODE,
                                   trunkUrlId: NEW_DOCUMENT_CODE});
      await this._docManager.createNamedDoc(makeExceptionalDocSession('nascent', {
        req: req as RequestWithLogin,
        browserSettings
      }), docId);
      return res.status(200).json(docId);
    }));
  }

  /**
   * Check for read access to the given document, and return its
   * canonical docId.  Throws error if read access not available.
   * This method is used for documents that are not the main document
   * associated with the request, but are rather an extra source to be
   * read from, so the access information is not cached in the
   * request.
   */
  private async _confirmDocIdForRead(req: Request, urlId: string): Promise<string> {
    const userId = getUserId(req);
    const org = (req as RequestWithLogin).org;
    const docAuth = await makeDocAuthResult(this._dbManager.getDoc({urlId, userId, org}));
    if (docAuth.error) { throw docAuth.error; }
    assertAccess('viewers', docAuth);
    return docAuth.docId!;
  }

  private _getActiveDoc(req: RequestWithLogin): Promise<ActiveDoc> {
    return this._docManager.fetchDoc(docSessionFromRequest(req), getDocId(req));
  }

  private _getActiveDocIfAvailable(req: RequestWithLogin): Promise<ActiveDoc>|undefined {
    return this._docManager.getActiveDoc(getDocId(req));
  }

  private async _assertAccess(role: 'viewers'|'editors'|'owners'|null, allowRemoved: boolean,
                              req: Request, res: Response, next: NextFunction) {
    const scope = getDocScope(req);
    allowRemoved = scope.showAll || scope.showRemoved || allowRemoved;
    const docAuth = await getOrSetDocAuth(req as RequestWithLogin, this._dbManager, scope.urlId);
    if (role) { assertAccess(role, docAuth, {allowRemoved}); }
    next();
  }

  /**
   * Check if user is an owner of the document.
   */
  private async _isOwner(req: Request) {
    const scope = getDocScope(req);
    const docAuth = await getOrSetDocAuth(req as RequestWithLogin, this._dbManager, scope.urlId);
    return docAuth.access === 'owners';
  }

  // Helper to generate a 503 if the ActiveDoc has been muted.
  private _checkForMute(activeDoc: ActiveDoc|undefined) {
    if (activeDoc && activeDoc.muted) {
      throw new ApiError('Document in flux - try again later', 503);
    }
  }

  /**
   * Throws an error if, during processing, the ActiveDoc becomes "muted".  Also replaces any
   * other error that may have occurred if the ActiveDoc becomes "muted", since the document
   * shutting down during processing may have caused a variety of errors.
   *
   * Expects to be called within a handler that catches exceptions.
   */
  private _requireActiveDoc(callback: WithDocHandler): RequestHandler {
    return async (req, res) => {
      let activeDoc: ActiveDoc|undefined;
      try {
        activeDoc = await this._getActiveDoc(req as RequestWithLogin);
        await callback(activeDoc, req as RequestWithLogin, res);
        if (!res.headersSent) { this._checkForMute(activeDoc); }
      } catch (err) {
        this._checkForMute(activeDoc);
        throw err;
      }
    };
  }

  private async _getStates(docSession: OptDocSession, activeDoc: ActiveDoc): Promise<DocStates> {
    const states = await activeDoc.getRecentStates(docSession);
    return {
      states,
    };
  }

  /**
   *
   * Calculate changes between two document versions identified by leftHash and rightHash.
   * If rightHash is the latest version of the document, the ActionSummary for it will
   * contain a copy of updated and added rows.
   *
   * Currently will fail if leftHash is not an ancestor of rightHash (this restriction could
   * be lifted, but is adequate for now).
   *
   */
  private async _getChanges(docSession: OptDocSession, activeDoc: ActiveDoc, states: DocState[],
                            leftHash: string, rightHash: string): Promise<DocStateComparison> {
    const finder = new HashUtil(states);
    const leftOffset = finder.hashToOffset(leftHash);
    const rightOffset = finder.hashToOffset(rightHash);
    if (rightOffset > leftOffset) {
      throw new Error('Comparisons currently require left to be an ancestor of right');
    }
    const actionNums: number[] = states.slice(rightOffset, leftOffset).map(state => state.n);
    const actions = (await activeDoc.getActions(actionNums)).reverse();
    let totalAction = createEmptyActionSummary();
    for (const action of actions) {
      if (!action) { continue; }
      const summary = summarizeAction(action);
      totalAction = concatenateSummaries([totalAction, summary]);
    }
    const result: DocStateComparison = {
      left: states[leftOffset],
      right: states[rightOffset],
      parent: states[leftOffset],
      summary: (leftOffset === rightOffset) ? 'same' : 'right',
      details: {
        leftChanges: {tableRenames: [], tableDeltas: {}},
        rightChanges: totalAction
      }
    };
    return result;
  }

  private async _removeDoc(req: Request, res: Response, permanent: boolean) {
    const scope = getDocScope(req);
    const docId = getDocId(req);
    if (permanent) {
      const query = await this._dbManager.deleteDocument(scope);
      this._dbManager.checkQueryResult(query);  // fail immediately if deletion denied.
      await this._docManager.deleteDoc(null, docId, true);
      await sendReply(req, res, query);
    } else {
      await this._dbManager.softDeleteDocument(scope);
      await sendOkReply(req, res);
    }
    await this._dbManager.flushSingleDocAuthCache(scope, docId);
    await this._docManager.interruptDocClients(docId);
  }
}

export function addDocApiRoutes(
  app: Application, docWorker: DocWorker, docWorkerMap: IDocWorkerMap, docManager: DocManager, dbManager: HomeDBManager,
  grist: GristServer
) {
  const api = new DocWorkerApi(app, docWorker, docWorkerMap, docManager, dbManager, grist);
  api.addEndpoints();
}

/**
 * Catches the errors thrown by the sandbox, and converts to more descriptive ones (such as for
 * invalid table names, columns, or rowIds) with better status codes. Accepts the table name, a
 * list of column names in that table, and a promise for the result of the sandbox call.
 */
async function handleSandboxError<T>(tableId: string, colNames: string[], p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof SandboxError) {
      let match = e.message.match(/non-existent record #([0-9]+)/);
      if (match) {
        throw new ApiError(`Invalid row id ${match[1]}`, 400);
      }
      match = e.message.match(/\[Sandbox\] KeyError '(.*?)'/);
      if (match) {
        if (match[1] === tableId) {
          throw new ApiError(`Table not found "${tableId}"`, 404);
        } else if (colNames.includes(match[1])) {
          throw new ApiError(`Invalid column "${match[1]}"`, 400);
        }
      }
      throw new ApiError(`Error doing API call: ${e.message}`, 400);
    }
    throw e;
  }
}

/**
 * Options for returning results from a query about document data.
 * Currently these option don't affect the query itself, only the
 * results returned to the user.
 */
export interface QueryParameters {
  sort?: string[];  // Columns to sort by (ascending order by default,
                    // prepend "-" for descending order).
  limit?: number;   // Limit on number of rows to return.
}


/**
 * Extract a sort parameter from a request, if present.  Follows
 * https://jsonapi.org/format/#fetching-sorting for want of a better
 * standard - comma separated, defaulting to ascending order, keys
 * prefixed by "-" for descending order.
 *
 * The sort parameter can either be given as a query parameter, or
 * as a header.
 */
function getSortParameter(req: Request): string[]|undefined {
  const sortString: string|undefined = optStringParam(req.query.sort) || req.get('X-Sort');
  if (!sortString) { return undefined; }
  return sortString.split(',');
}

/**
 * Extract a limit parameter from a request, if present.  Should be a
 * simple integer.  The limit parameter can either be given as a query
 * parameter, or as a header.
 */
function getLimitParameter(req: Request): number|undefined {
  const limitString: string|undefined = optStringParam(req.query.limit) || req.get('X-Limit');
  if (!limitString) { return undefined; }
  const limit = parseInt(limitString, 10);
  if (isNaN(limit)) { throw new Error('limit is not a number'); }
  return limit;
}

/**
 * Extract sort and limit parameters from request, if they are present.
 */
function getQueryParameters(req: Request): QueryParameters {
  return {
    sort: getSortParameter(req),
    limit: getLimitParameter(req),
  };
}

/**
 * Sort table contents being returned.  Sort keys with a '-' prefix
 * are sorted in descending order, otherwise ascending.  Contents are
 * modified in place.
 */
function applySort(values: TableColValues, sort: string[]) {
  if (!sort) { return values; }
  const sortKeys = sort.map(key => key.replace(/^-/, ''));
  const iteratees = sortKeys.map(key => {
    if (!(key in values)) {
      throw new Error(`unknown key ${key}`);
    }
    const col = values[key];
    return (i: number) => col[i];
  });
  const sortSpec = sort.map((key, i) => (key.startsWith('-') ? -i - 1 : i + 1));
  const index = values.id.map((_, i) => i);
  const sortFunc = new SortFunc({
    getColGetter(i) { return iteratees[i - 1]; },
    getManualSortGetter() { return null; }
  });
  sortFunc.updateSpec(sortSpec);
  index.sort(sortFunc.compare.bind(sortFunc));
  for (const key of Object.keys(values)) {
    const col = values[key];
    values[key] = index.map(i => col[i]);
  }
  return values;
}

/**
 * Truncate columns to the first N values.  Columns are modified in place.
 */
function applyLimit(values: TableColValues, limit: number) {
  // for no limit, or 0 limit, do not apply any restriction
  if (!limit) { return values; }
  for (const key of Object.keys(values)) {
    values[key].splice(limit);
  }
  return values;
}

/**
 * Apply query parameters to table contents.  Contents are modified in place.
 */
export function applyQueryParameters(values: TableColValues, params: QueryParameters): TableColValues {
  if (params.sort) { applySort(values, params.sort); }
  if (params.limit) { applyLimit(values, params.limit); }
  return values;
}
