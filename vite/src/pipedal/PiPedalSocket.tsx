// Copyright (c) Robin E.R. Davies
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of
// this software and associated documentation files (the "Software"), to deal in
// the Software without restriction, including without limitation the rights to
// use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
// the Software, and to permit persons to whom the Software is furnished to do so,
// subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
// FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
// COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
// IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
// CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import { PiPedalStateError } from './PiPedalError';

export type MessageHandler = (header: PiPedalMessageHeader, body: any | null) => void;
export type ErrorHandler = (message: string, exception?: Error) => void;
export type ReconnectHandler = () => void;
export type ReconnectingHandler = (retry: number, maxRetries: number) => void;

const MAX_RETRIES = 6;
const MAX_RETRY_TIME = 90 * 1000;

export type PiPedalMessageHeader = {
    replyTo?: number;
    reply?: number;
    message: string;
}
type ReplyHandler = (header: PiPedalMessageHeader, body: any | null) => void;
type ReplyReservation = { handle: ReplyHandler; reject: (reason: Error) => void; generation: number };


export interface PiPedalSocketListener {
    onMessageReceived: (header: PiPedalMessageHeader, body: any | null) => void;
    onError: (message: string, exception?: Error) => void;
    onConnectionLost: () => void | Promise<void>;
    onReconnect: () => void | Promise<void>;
    onReconnecting: (retry: number, maxRetries: number) => boolean;
};

/** Requests have one transport owner and always settle when that transport ends.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-RECOVERY] [3.16]
 */
class PiPedalSocket {

    listener: PiPedalSocketListener;


    socket?: WebSocket;
    nextResponseCode: number = 0;
    url: string;
    retrying: boolean = false;
    retryCount: number = 0;
    retryDelay: number = 0;
    totalRetryDelay: number = 0;
    private transportGeneration = 0;
    private reconnectGeneration = 0;
    private disposed = false;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private connecting?: { socket: WebSocket; reject: (reason: Error) => void };

    constructor(
        url: string,
        listener: PiPedalSocketListener
    ) {
        this.url = url;
        this.listener = listener;
    }

    handleOpen(event: Event): any {

    }

    sendInternal_(json: string) {
        if (!this.retrying) {
            this.socket?.send(json);
        }
    }
    send(message: string, jsonObject?: any) {
        let msg: any;
        if (jsonObject === undefined) {
            msg = [{ message: message }];
        } else {
            msg = [{ message: message }, jsonObject];
        }
        let json = JSON.stringify(msg);
        this.sendInternal_(json);
    }
    reply(replyTo: number, message: string, jsonObject?: any) {
        if (replyTo !== -1) {
            let msg: any;
            if (jsonObject === undefined) {
                msg = [{ reply: replyTo, message: message }];
            } else {
                msg = [{ reply: replyTo, message: message }, jsonObject];
            }
            let json = JSON.stringify(msg);
            this.sendInternal_(json);
        }
    }

    _nextResponseCode(): number {
        return ++this.nextResponseCode;
    }

    _replyMap: Map<number, ReplyReservation> = new Map<number, ReplyReservation>();

    /** Reject rather than strand promises; a mutation may already have completed.
     * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-RECOVERY] [3.16]
     */
    _discardReplyReservations(reason = "Server connection lost before reply; operation outcome is unknown. Refresh before retrying.") {
        const pending = this._replyMap;
        this._replyMap = new Map<number, ReplyReservation>();
        for (const reservation of pending.values()) reservation.reject(new PiPedalStateError(reason));
    }


    _addReservation(replyCode: number, handler: ReplyHandler, reject: (reason: Error) => void): void {
        this._replyMap.set(replyCode, { handle: handler, reject, generation: this.transportGeneration });
    }

    request<Type = any>(message_: string, requestArgs?: any): Promise<Type> {
        let responseCode = this._nextResponseCode();

        const promise = new Promise<Type>((resolve, reject) => {
            try {
                if (this.disposed || this.isBackground || this.retrying || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
                    throw new PiPedalStateError("Server connection unavailable; request was not sent.");
                }
                this._addReservation(responseCode, (header: PiPedalMessageHeader, jsonObject?: any) => {
                    if (header.message === "error") {
                        reject(jsonObject + "");
                    } else {
                        resolve(jsonObject as Type);
                    }
                }, reject);
                let msg: any;
                if (requestArgs !== undefined) {
                    msg = [{ message: message_, replyTo: responseCode }, requestArgs];
                } else {
                    msg = [{ message: message_, replyTo: responseCode }];
                }
                let jsonMessage = JSON.stringify(msg);
                this.sendInternal_(jsonMessage);
            } catch (err) {
                this._replyMap.delete(responseCode);
                reject(err);
            }
        });
        // Legacy direct fire-and-forget callers must not raise an unhandled
        // rejection. Consumers still receive the original rejected promise.
        void promise.catch(() => { });
        return promise;
    }
    handleMessage(event: MessageEvent<string>): any {
        try {
            let message: any = JSON.parse(event.data);
            if (!Array.isArray(message)) {
                throw new PiPedalStateError("Invalid message received from server.");
            }
            let header = message[0] as PiPedalMessageHeader;
            let body = undefined;
            if (message.length === 2) {
                body = message[1];
            }
            if (header.reply !== undefined) {
                let handler = this._replyMap.get(header.reply);
                if (handler && handler.generation === this.transportGeneration) {
                    this._replyMap.delete(header.reply);
                    handler.handle(header, body);
                }
                return;
            } else {
                if (header.message === "error") {
                    throw new PiPedalStateError("Server error: " + body);
                }
                this.listener.onMessageReceived(header, body);
            }
        } catch (error) {
            if (this.listener) {
                this.listener.onError("Invalid server response. " + error, error as Error);
            } else {
                throw new PiPedalStateError("Invalid server response.");
            }
        }
    }

    handleError(_event: Event): any {
        this._discardReplyReservations();
        if (this.listener) {
            this.listener.onError("Server connection lost.");
        } else {
            throw new PiPedalStateError("Server connection lost.");
        }
    }

    canReconnect: boolean = false;

    handleClose(_event: any): any {
        this.disconnectTransport();
        if (this.disposed || this.isBackground) return;
        if (this.retrying) {
            this.close();
            // treat this as a fatal error.
            if (this.listener) {
                this.listener.onError("Server connection lost.");
            } else {
                throw new PiPedalStateError("Server connection closed.");
            }
            return;

        }
        if (this.canReconnect) {
            let notified: void | Promise<void> = undefined;
            try { notified = this.listener.onConnectionLost(); }
            catch (error) {
                this.listener.onError("Failed to handle lost server connection.", error instanceof Error ? error : undefined);
            }
            this._reconnect();
            const generation = this.reconnectGeneration;
            void Promise.resolve(notified).catch(error => {
                if (generation === this.reconnectGeneration && !this.disposed)
                    this.listener.onError("Failed to handle lost server connection.", error instanceof Error ? error : undefined);
            });
        }
    }
    _reconnect() {
        if (this.disposed || this.isBackground) return;
        ++this.reconnectGeneration;
        clearTimeout(this.reconnectTimer);
        this.disconnectTransport();
        this.retrying = true;
        this.retryCount = 0;
        this.socket = undefined;
        this.retryDelay = 10000;
        this.totalRetryDelay = 0;

        this.reconnect();
    }

    isBackground: boolean = false;

    enterBackgroundState() {
        this.isBackground = true;
        this.close();

    }
    exitBackgroundState() {
        this.isBackground = false;
        this.disposed = false;
        this._reconnect();
    }

    reconnect() {
        if (this.disposed || this.isBackground) return;
        const generation = this.reconnectGeneration;

        if (!this.listener.onReconnecting(this.retryCount, MAX_RETRIES)) {
            return;
        }
        ++this.retryCount;

        this.connectInternal_()
            .then((socket) => {
                if (generation !== this.reconnectGeneration || this.disposed || this.socket !== socket) return;
                this.retrying = false;
                // The model's reconnect callback is async even though the
                // listener interface also permits synchronous implementations.
                return Promise.resolve(this.listener.onReconnect()).catch(error => {
                    if (generation === this.reconnectGeneration && !this.disposed)
                        this.listener.onError("Failed to restore server connection.", error instanceof Error ? error : undefined);
                });
            })
            .catch(error => {
                if (generation !== this.reconnectGeneration || this.disposed || this.isBackground) return;
                if (this.totalRetryDelay >= MAX_RETRY_TIME) {
                    this.listener.onError("Server connection lost.");
                    return;
                } else {
                    this.totalRetryDelay += this.retryDelay;
                    this.reconnectTimer = setTimeout(() => {
                        if (generation === this.reconnectGeneration && !this.disposed && !this.isBackground) this.reconnect();
                    }, this.retryDelay);
                    this.retryDelay *= 2;
                    if (this.retryDelay > 3000) this.retryDelay = 3000;
                }
            });
    }

    close(): void {
        this.disposed = true;
        this.retrying = false;
        ++this.reconnectGeneration;
        clearTimeout(this.reconnectTimer);
        this.disconnectTransport();
    }
    /** Cancel connecting/open transports and make queued old events harmless.
     * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-RECOVERY] [3.16]
     */
    private disconnectTransport() {
        ++this.transportGeneration;
        this._discardReplyReservations();
        const connecting = this.connecting;
        this.connecting = undefined;
        if (connecting) connecting.reject(new PiPedalStateError("Server connection attempt cancelled."));
        const sockets = new Set([this.socket, connecting?.socket]);
        this.socket = undefined;
        for (const socket of sockets) if (socket) {
            socket.onclose = null; socket.onerror = null; socket.onmessage = null; socket.onopen = null;
            try { socket.close(); } catch { /* Already closed transports need no further action. */ }
        }
    }
    connectInternal_(): Promise<WebSocket> {
        const generation = ++this.transportGeneration;
        return new Promise<WebSocket>((resolve, reject) => {
            try {
                let ws = new WebSocket(this.url);
                this.connecting = { socket: ws, reject };
                const current = () => generation === this.transportGeneration && !this.disposed && !this.isBackground;
                const fail = (message: string) => {
                    if (!current()) return;
                    this.connecting = undefined;
                    ws.onclose = null;
                    ws.onerror = null;
                    ws.onopen = null;
                    ws.onmessage = null;
                    try { ws.close(); } catch { }
                    reject(new PiPedalStateError(message));
                };
                ws.onmessage = event => { if (current() && this.socket === ws) this.handleMessage(event); };
                ws.onclose = event => {
                    if (!current()) return;
                    if (this.connecting?.socket === ws) fail("Connection closed unexpectedly.");
                    else if (this.socket === ws) this.handleClose(event);
                };
                ws.onerror = event => {
                    if (!current()) return;
                    if (this.connecting?.socket === ws) fail("Connection not accepted.");
                    else if (this.socket === ws) this.handleError(event);
                };
                ws.onopen = () => {
                    if (!current()) return;
                    this.connecting = undefined;
                    this.socket = ws;
                    ws.onopen = null;
                    resolve(ws);
                };
            } catch (e: any){
                reject("Failed to connect: " + e.toString());
            };
        });
}
async connect(): Promise<void> {
    this.disposed = false;
    this.retrying = false;
    ++this.reconnectGeneration;
    clearTimeout(this.reconnectTimer);
    this.disconnectTransport();
    const socket = await this.connectInternal_();
    if (this.disposed || this.socket !== socket) throw new PiPedalStateError("Server connection attempt cancelled.");
}

}

export default PiPedalSocket;
