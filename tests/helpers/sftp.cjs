'use strict';
// A jailed, opt-in SFTP fixture. It only touches an explicit test-output directory.
const fs = require('node:fs');
const path = require('node:path');
const { utils: { sftp: { STATUS_CODE: S, OPEN_MODE: M } } } = require('ssh2');
function serveSftp(sftp, root, options, stats) {
  const handles = new Map(); let sequence = 0, closed = false;
  stats.sftp ||= { reads: [], writes: [], opens: 0, requests: [] };
  const originalSend = sftp._protocol.channelData.bind(sftp._protocol);
  const protocol = Object.create(sftp._protocol);
  protocol.channelData = (id, buffer) => {
    if (id === sftp.outgoing.id && buffer.length === 9 && buffer[4] === 2) {
      const string = value => { const b = Buffer.from(value); const header = Buffer.alloc(4); header.writeUInt32BE(b.length); return Buffer.concat([header, b]); };
      buffer = Buffer.concat([buffer, string('posix-rename@openssh.com'), string('1')]); buffer.writeUInt32BE(buffer.length - 4);
    }
    return originalSend(id, buffer);
  };
  sftp._protocol = protocol;
  const local = remote => {
    const normalized = path.posix.resolve('/home/tester', remote);
    const full = path.resolve(root, `.${normalized}`);
    if (!full.startsWith(path.resolve(root) + path.sep) && full !== path.resolve(root)) throw Error('Outside fixture');
    return full;
  };
  const attrs = m => ({ mode: m.mode, size: m.size, uid: 1000, gid: 1000, atime: Math.floor(m.atimeMs / 1000), mtime: Math.floor(m.mtimeMs / 1000) });
  const status = (id, error) => { if (!closed) sftp.status(id, error ? error.code === 'ENOENT' ? S.NO_SUCH_FILE : error.code === 'EACCES' ? S.PERMISSION_DENIED : S.FAILURE : S.OK, error?.message || ''); };
  const on = (event, fn) => sftp.on(event, (id, ...args) => { stats.sftp.requests.push(event); try { fn(id, ...args); } catch (error) { status(id, error); } });
  const handle = object => { const key = Buffer.alloc(4); key.writeUInt32BE(++sequence); handles.set(sequence, object); return key; };
  const get = key => { const value = key.length === 4 && handles.get(key.readUInt32BE()); if (!value) throw Error('Invalid handle'); return value; };
  on('REALPATH', (id, name) => { const full = fs.realpathSync(local(name)); const remote = '/' + path.relative(root, full).split(path.sep).join('/'); sftp.name(id, [{ filename: remote, longname: remote, attrs: attrs(fs.statSync(full)) }]); });
  on('STAT', (id, name) => sftp.attrs(id, attrs(fs.statSync(local(name)))));
  on('LSTAT', (id, name) => sftp.attrs(id, attrs(fs.lstatSync(local(name)))));
  on('OPENDIR', (id, name) => sftp.handle(id, handle({ directory: local(name), done: false })));
  on('READDIR', (id, key) => { const h = get(key); if (h.done) return sftp.status(id, S.EOF); h.done = true;
    sftp.name(id, fs.readdirSync(h.directory).map(name => ({ filename: name, longname: name, attrs: attrs(fs.lstatSync(path.join(h.directory, name))) }))); });
  on('OPEN', (id, name, flags, attributes) => {
    const c = fs.constants; let mode = flags & M.WRITE ? flags & M.READ ? c.O_RDWR : c.O_WRONLY : c.O_RDONLY;
    if (flags & M.CREAT) mode |= c.O_CREAT; if (flags & M.TRUNC) mode |= c.O_TRUNC; if (flags & M.EXCL) mode |= c.O_EXCL;
    const fd = fs.openSync(local(name), mode, attributes.mode || 0o644); stats.sftp.opens++;
    sftp.handle(id, handle({ fd, name }));
  });
  on('READ', (id, key, offset, length) => {
    const h = get(key); const run = () => { if (closed) return; try {
      const bytes = Buffer.alloc(Math.min(length, 32768)); const count = fs.readSync(h.fd, bytes, 0, bytes.length, offset);
      stats.sftp.reads.push({ name: h.name, offset, count }); if (count) sftp.data(id, bytes.subarray(0, count)); else sftp.status(id, S.EOF);
    } catch (error) { status(id, error); } };
    if (options.sftpReadDelay) setTimeout(run, options.sftpReadDelay); else run();
  });
  on('WRITE', (id, key, offset, data) => { const h = get(key);
    if (options.sftpFailWrite) return status(id, Object.assign(Error('Simulated write failure'), { code: 'EACCES' }));
    fs.writeSync(h.fd, data, 0, data.length, offset); stats.sftp.writes.push({ name: h.name, offset, count: data.length }); status(id);
  });
  on('FSTAT', (id, key) => sftp.attrs(id, attrs(fs.fstatSync(get(key).fd))));
  on('FSETSTAT', (id, key, a) => { if (a.size !== undefined) fs.ftruncateSync(get(key).fd, a.size); status(id); });
  on('SETSTAT', (id, name, a) => { if (a.mode !== undefined) fs.chmodSync(local(name), a.mode); status(id); });
  on('CLOSE', (id, key) => { const h = get(key); if (h.fd !== undefined) fs.closeSync(h.fd); handles.delete(key.readUInt32BE()); status(id); });
  on('MKDIR', (id, name) => { fs.mkdirSync(local(name)); status(id); });
  on('REMOVE', (id, name) => { fs.unlinkSync(local(name)); status(id); });
  on('RMDIR', (id, name) => { fs.rmdirSync(local(name)); status(id); });
  on('RENAME', (id, from, to) => { if (fs.existsSync(local(to))) throw Error('Destination exists'); fs.renameSync(local(from), local(to)); status(id); });
  on('READLINK', (id, name) => sftp.name(id, [{ filename: fs.readlinkSync(local(name)), longname: '', attrs: {} }]));
  on('EXTENDED', (id, name, data) => {
    if (name !== 'posix-rename@openssh.com') return sftp.status(id, S.OP_UNSUPPORTED);
    let cursor = 0; const next = () => { const length = data.readUInt32BE(cursor); cursor += 4; const value = data.toString('utf8', cursor, cursor + length); cursor += length; return value; };
    const from = next(), to = next(); fs.renameSync(local(from), local(to)); status(id);
  });
  sftp.on('close', () => { closed = true; for (const h of handles.values()) if (h.fd !== undefined) { try { fs.closeSync(h.fd); } catch {} } handles.clear(); });
}
module.exports = { serveSftp };
