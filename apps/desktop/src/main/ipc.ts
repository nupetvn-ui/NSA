import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import type {
  ChatService,
  CliChange,
  IpcArgs,
  IpcChannel,
  IpcResult,
  NsaCore,
  PluginsIpcContract,
} from '@nsa/core';
import type { ProvidersSetup } from './providers';
import type { MemoryRuntime } from '@nsa/memory';
import { cleanCommit, cleanIds, cleanPatch, cleanSource, cleanTeach } from './memory';
import { getUpdateStatus, installUpdate } from './updater';

type Handlers = {
  [C in IpcChannel]: (...args: IpcArgs<C>) => IpcResult<C> | Promise<IpcResult<C>>;
};

/** Đăng ký trình xử lý cho mọi kênh trong hợp đồng IPC — thiếu kênh nào TypeScript báo lỗi. */
export function registerIpc(
  core: NsaCore,
  chat: ChatService,
  cliChanges: () => CliChange[],
  providers: ProvidersSetup,
  memory: {
    runtime: MemoryRuntime;
    mcpUrl: string | null;
    plugins: {
      [C in keyof PluginsIpcContract]: (
        ...args: PluginsIpcContract[C]['args']
      ) => PluginsIpcContract[C]['result'] | Promise<PluginsIpcContract[C]['result']>;
    };
  },
): void {
  const mem = memory.runtime.service;
  const runtime = memory.runtime;
  const handlers: Handlers = {
    ...providers.handlers,
    ...memory.plugins,
    'core:ping': (message) => core.ping(message),
    'app:info': () => ({ name: app.getName(), version: app.getVersion() }),
    'app:updateStatus': () => getUpdateStatus(),
    'app:installUpdate': () => installUpdate(),
    'agents:list': () => chat.listAgents(),
    'chat:list': () => chat.listConversations(),
    'chat:send': (request) => chat.send(request),
    'chat:cancel': (turnId) => chat.cancel(turnId),
    'chat:delete': (conversationId) => chat.deleteConversation(conversationId),
    'chat:answerPermission': (permissionId, allowed) =>
      chat.answerPermission(String(permissionId), allowed === true),
    'agents:changes': () => cliChanges(),
    'dialog:pickFolder': async () => {
      const win = BrowserWindow.getFocusedWindow();
      const options = {
        title: 'Chọn thư mục làm việc cho agent',
        properties: ['openDirectory' as const],
      };
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    'mem:info': () => ({
      root: mem.root,
      entries: mem.listEntries().length,
      pending: mem.listProposals('pending').length,
      vector: mem.vectorAvailable,
      mcpUrl: memory.mcpUrl,
    }),
    'mem:branches': () => mem.listBranches(),
    'mem:saveBranch': (path, input) =>
      mem.saveBranch(String(path), {
        ...(typeof input?.title === 'string' ? { title: input.title } : {}),
        ...(typeof input?.description === 'string' ? { description: input.description } : {}),
        ...(typeof input?.autoApprove === 'boolean' ? { autoApprove: input.autoApprove } : {}),
        ...(typeof input?.minConfidence === 'number'
          ? { minConfidence: Math.min(1, Math.max(0, input.minConfidence)) }
          : {}),
        ...(typeof input?.hidden === 'boolean' ? { hidden: input.hidden } : {}),
      }),
    'mem:list': (branch) => mem.listEntries(typeof branch === 'string' ? branch : undefined),
    'mem:search': (query) => mem.search(String(query), { limit: 30 }),
    'mem:teach': (input) => mem.teach(cleanTeach(input)),
    'mem:update': (id, patch) => mem.update(String(id), cleanPatch(patch)),
    'mem:delete': (id) => mem.delete(String(id)),
    'mem:history': (entryId) =>
      mem.history(typeof entryId === 'string' ? { entryId } : { limit: 100 }),
    'mem:undo': (commit) => mem.undo(cleanCommit(commit)),
    'mem:proposals': (status) =>
      mem.listProposals(
        status === 'pending' || status === 'accepted' || status === 'rejected' ? status : undefined,
      ),
    'mem:accept': (id, edits, replaceId) =>
      mem.accept(
        String(id),
        cleanPatch(edits),
        typeof replaceId === 'string' ? { replace: replaceId } : {},
      ),
    'mem:reject': (id) => mem.reject(String(id)),
    'mem:reindex': () => mem.rebuildIndex(),
    'mem:settings': () => runtime.settings(),
    'mem:saveSettings': (patch) => runtime.saveSettings(patch ?? {}),
    'mem:status': () => runtime.status(),
    'mem:distill': (conversationId) => runtime.distillConversation(String(conversationId)),
    'mem:importSources': () => runtime.importer.sources(),
    'mem:importList': (source) => runtime.importer.list(cleanSource(source)),
    'mem:import': (source, ids) => runtime.importSessions(cleanSource(source), cleanIds(ids)),
    'mem:openFolder': async () => {
      await shell.openPath(mem.root);
    },
  };

  for (const channel of Object.keys(handlers) as IpcChannel[]) {
    const handler = handlers[channel] as (...args: unknown[]) => unknown;
    ipcMain.handle(channel, (_event, ...args: unknown[]) => handler(...args));
  }
}
