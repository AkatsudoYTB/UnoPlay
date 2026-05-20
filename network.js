/* =========================================================
   UNO Online — Networking (PeerJS WebRTC P2P)
   Exposes window.UnoNet
   =========================================================
   Architecture:
     - Host opens a Peer with id = "unofr-{ROOMCODE}"
     - Clients open Peers with random ids and connect to host
     - All game state lives on the host. Clients send actions, receive views.

   Public rooms discovery:
     - A "directory" peer id ("unofr-directory-v1") is well-known.
     - First public host claims it (acting as both directory + room host).
     - Other hosts register their rooms with the directory.
     - Clients query the directory for the list.
     - If directory is offline, public rooms is unavailable but join-by-code
       still works.
   ========================================================= */

(function () {
  'use strict';

  const ROOM_PEER_PREFIX  = 'unofr-room-';
  const DIRECTORY_PEER_ID = 'unofr-directory-v1-2026';

  // STUN servers (free, public). Used for NAT traversal on public WiFi.
  const PEER_CONFIG = {
    debug: 1,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' }
      ]
    }
  };

  /* =========================================================
     HOST
     ========================================================= */
  class Host extends EventTarget {
    constructor(roomCode) {
      super();
      this.roomCode = roomCode;
      this.peerId = ROOM_PEER_PREFIX + roomCode;
      this.peer = null;
      this.connections = new Map(); // peerId -> { conn, name }
      this.opened = false;
    }

    async start() {
      return new Promise((resolve, reject) => {
        this.peer = new Peer(this.peerId, PEER_CONFIG);
        const onOpen = () => {
          this.opened = true;
          resolve();
        };
        const onError = (err) => {
          if (err.type === 'unavailable-id') {
            reject(new Error("Le code est déjà utilisé par un autre salon. Réessaie."));
          } else if (err.type === 'network' || err.type === 'disconnected') {
            // Recoverable; let caller decide
            this.dispatchEvent(new CustomEvent('network-error', { detail: err }));
          } else if (!this.opened) {
            reject(err);
          } else {
            this.dispatchEvent(new CustomEvent('network-error', { detail: err }));
          }
        };
        this.peer.on('open', onOpen);
        this.peer.on('error', onError);
        this.peer.on('connection', (conn) => this._onClientConnect(conn));
      });
    }

    _onClientConnect(conn) {
      conn.on('open', () => {
        this.connections.set(conn.peer, { conn, name: null });
        this.dispatchEvent(new CustomEvent('client-connected', { detail: { peerId: conn.peer } }));
      });
      conn.on('data', (raw) => {
        let msg;
        try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
        this.dispatchEvent(new CustomEvent('message', {
          detail: { peerId: conn.peer, message: msg }
        }));
      });
      conn.on('close', () => {
        this.connections.delete(conn.peer);
        this.dispatchEvent(new CustomEvent('client-disconnected', { detail: { peerId: conn.peer } }));
      });
      conn.on('error', () => { /* swallow */ });
    }

    sendTo(peerId, message) {
      const entry = this.connections.get(peerId);
      if (entry && entry.conn.open) entry.conn.send(message);
    }

    broadcast(message, except) {
      for (const [pid, entry] of this.connections) {
        if (pid === except) continue;
        if (entry.conn.open) entry.conn.send(message);
      }
    }

    kick(peerId, reason) {
      const entry = this.connections.get(peerId);
      if (entry) {
        try { entry.conn.send({ type: 'kicked', reason }); } catch {}
        setTimeout(() => { try { entry.conn.close(); } catch {} }, 200);
      }
    }

    close() {
      if (this.peer) {
        try { this.peer.destroy(); } catch {}
      }
      this.connections.clear();
    }
  }

  /* =========================================================
     CLIENT
     ========================================================= */
  class Client extends EventTarget {
    constructor() {
      super();
      this.peer = null;
      this.conn = null;
      this.connected = false;
    }

    async connect(roomCode) {
      const hostPeerId = ROOM_PEER_PREFIX + roomCode;
      return new Promise((resolve, reject) => {
        this.peer = new Peer(undefined, PEER_CONFIG);
        let openHandled = false;

        const timeout = setTimeout(() => {
          if (!this.connected) reject(new Error("Impossible de se connecter au salon (timeout). Vérifie le code."));
        }, 15000);

        this.peer.on('open', () => {
          openHandled = true;
          const conn = this.peer.connect(hostPeerId, { reliable: true });
          this.conn = conn;

          conn.on('open', () => {
            this.connected = true;
            clearTimeout(timeout);
            resolve();
          });
          conn.on('data', (raw) => {
            let msg;
            try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
            this.dispatchEvent(new CustomEvent('message', { detail: msg }));
          });
          conn.on('close', () => {
            this.connected = false;
            this.dispatchEvent(new CustomEvent('disconnected'));
          });
          conn.on('error', (err) => {
            if (!this.connected) {
              clearTimeout(timeout);
              reject(new Error("Erreur de connexion. Le salon existe-t-il toujours ?"));
            }
          });
        });

        this.peer.on('error', (err) => {
          if (err.type === 'peer-unavailable') {
            clearTimeout(timeout);
            reject(new Error("Salon introuvable. Vérifie le code."));
          } else if (!openHandled) {
            clearTimeout(timeout);
            reject(err);
          }
        });
      });
    }

    send(message) {
      if (this.conn && this.conn.open) this.conn.send(message);
    }

    close() {
      if (this.conn) try { this.conn.close(); } catch {}
      if (this.peer) try { this.peer.destroy(); } catch {}
    }
  }

  /* =========================================================
     DIRECTORY (Public-rooms discovery)
     ========================================================= */
  class Directory extends EventTarget {
    constructor() {
      super();
      this.peer = null;
      this.role = null; // 'server' | 'client' | null
      this.rooms = new Map(); // roomCode -> { name, players, max, code }
      this.directoryConn = null; // when client, the connection to directory peer
      this.clientConnections = new Map(); // when server, peerId -> conn (room hosts/list askers)
      this.myRoom = null; // when I'm a host publishing my room
    }

    /**
     * Try to become the directory server. If it's taken, become a client.
     */
    async claimOrConnect() {
      return new Promise((resolve) => {
        this.peer = new Peer(DIRECTORY_PEER_ID, PEER_CONFIG);
        let resolved = false;

        this.peer.on('open', () => {
          if (resolved) return;
          resolved = true;
          this.role = 'server';
          this._setupServer();
          resolve('server');
        });

        this.peer.on('error', (err) => {
          if (err.type === 'unavailable-id') {
            // Directory already exists; connect as client
            try { this.peer.destroy(); } catch {}
            this._connectAsClient().then(() => {
              if (!resolved) { resolved = true; resolve('client'); }
            }).catch(() => {
              if (!resolved) { resolved = true; resolve(null); }
            });
          } else if (!resolved) {
            resolved = true;
            resolve(null);
          }
        });
      });
    }

    _setupServer() {
      this.peer.on('connection', (conn) => {
        conn.on('open', () => {
          this.clientConnections.set(conn.peer, conn);
        });
        conn.on('data', (raw) => {
          let msg;
          try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
          this._onServerMessage(conn, msg);
        });
        conn.on('close', () => {
          this.clientConnections.delete(conn.peer);
          // If this peer had registered a room, remove it
          for (const [code, room] of this.rooms) {
            if (room.ownerPeer === conn.peer) this.rooms.delete(code);
          }
        });
        conn.on('error', () => {});
      });
    }

    _onServerMessage(conn, msg) {
      switch (msg.type) {
        case 'register':
          this.rooms.set(msg.room.code, Object.assign({}, msg.room, { ownerPeer: conn.peer }));
          break;
        case 'update':
          if (this.rooms.has(msg.room.code)) {
            Object.assign(this.rooms.get(msg.room.code), msg.room);
          }
          break;
        case 'unregister':
          this.rooms.delete(msg.code);
          break;
        case 'list':
          // Don't include `ownerPeer` in the reply
          const rooms = [...this.rooms.values()].map(r => ({
            code: r.code, name: r.name, players: r.players, max: r.max
          }));
          if (conn.open) conn.send({ type: 'list-reply', rooms });
          break;
      }
    }

    async _connectAsClient() {
      this.peer = new Peer(undefined, PEER_CONFIG);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Directory timeout')), 8000);
        this.peer.on('open', () => {
          this.directoryConn = this.peer.connect(DIRECTORY_PEER_ID, { reliable: true });
          this.directoryConn.on('open', () => {
            this.role = 'client';
            clearTimeout(timeout);
            resolve();
          });
          this.directoryConn.on('data', (raw) => {
            let msg;
            try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
            if (msg.type === 'list-reply') {
              this.dispatchEvent(new CustomEvent('list-reply', { detail: msg.rooms }));
            }
          });
          this.directoryConn.on('error', () => {});
        });
        this.peer.on('error', (err) => {
          if (err.type === 'peer-unavailable') {
            clearTimeout(timeout);
            reject(new Error('Directory unavailable'));
          }
        });
      });
    }

    registerRoom(room) {
      this.myRoom = room;
      if (this.role === 'server') {
        this.rooms.set(room.code, Object.assign({}, room, { ownerPeer: 'self' }));
      } else if (this.role === 'client' && this.directoryConn) {
        this.directoryConn.send({ type: 'register', room });
      }
    }

    updateRoom(room) {
      if (this.role === 'server') {
        if (this.rooms.has(room.code)) Object.assign(this.rooms.get(room.code), room);
      } else if (this.role === 'client' && this.directoryConn) {
        this.directoryConn.send({ type: 'update', room });
      }
    }

    unregisterRoom(code) {
      if (this.role === 'server') {
        this.rooms.delete(code);
      } else if (this.role === 'client' && this.directoryConn) {
        this.directoryConn.send({ type: 'unregister', code });
      }
      this.myRoom = null;
    }

    /**
     * Fetch list of public rooms.
     */
    async fetchList(timeoutMs) {
      if (this.role === 'server') {
        return [...this.rooms.values()].map(r => ({
          code: r.code, name: r.name, players: r.players, max: r.max
        }));
      }
      if (this.role !== 'client' || !this.directoryConn) {
        return [];
      }
      return new Promise((resolve) => {
        const handler = (e) => {
          this.removeEventListener('list-reply', handler);
          resolve(e.detail);
        };
        this.addEventListener('list-reply', handler);
        this.directoryConn.send({ type: 'list' });
        setTimeout(() => {
          this.removeEventListener('list-reply', handler);
          resolve([]);
        }, timeoutMs || 4000);
      });
    }

    close() {
      if (this.peer) try { this.peer.destroy(); } catch {}
      this.rooms.clear();
      this.clientConnections.clear();
    }
  }

  /* =========================================================
     EXPORT
     ========================================================= */
  window.UnoNet = { Host, Client, Directory, DIRECTORY_PEER_ID, ROOM_PEER_PREFIX };
})();
