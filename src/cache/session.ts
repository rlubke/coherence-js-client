
import * as fs from 'fs';
import * as grpc from 'grpc';
import { EventEmitter } from 'events';

import { NamedCacheClient } from './named_cache_client';
import { ChannelCredentials } from 'grpc';
import { SerializerRegistry } from '../util/serializer';

/**
 * A class that uses Builder pattern to create the
 * set of options for a Session.
 *
 * The build() method makes a copy of the options
 * so that the same builder can be reused for
 * creating another Session.
 */
export class SessionBuilder {

    /**
     * The default target address to connect to Coherence gRPC server.
     */
    public static DEFAULT_ADDRESS = 'localhost:1408';

    /**
     * The default serialization format.
     */
    public static DEFAULT_FORMAT = 'json';

    /**
     * The {@link SessionOptions} to use when creating a Session.
     */
    private sessionOptions: SessionOptions;

    /**
     * Create a SessionBuilder.
     */
    constructor() {
        this.sessionOptions = new SessionOptions();
    }

    /**
     * Set the target address to connect to.
     *
     * @param address The target address to connect to.
     */
    withAddress(address: string): this {
        this.sessionOptions.address = address;
        return this;
    }

    /**
     * The maximum timeout in millis for a request to complete.
     *
     * @param requestTimeoutInMillis The maximum timeout in millis for a request to complete.
     */
    withRequestTimeout(requestTimeoutInMillis: number): this {
        this.sessionOptions.requestTimeoutInMillis = requestTimeoutInMillis;
        return this;
    }

    /**
     * Enable TLS. When TLS is set, withCaCert(), withClientCert() and
     * withClientKey() must also be called.
     */
    enableTls(): this {
        this.sessionOptions.tlsEnabled = true;
        return this;
    }

    /**
     * Disable TLS. Any caCert(), clientCert() and clientKey()
     * (if set) will be ignored.
     */
    disableTls(): this {
        this.sessionOptions.tlsEnabled = false;
        return this;
    }

    /**
     * Set the CA certificate path. enableTls() must also be called before
     * the build() method for this to be used.
     *
     * @param caCertPath The CA certificate path.
     */
    withCaCert(caCertPath: fs.PathLike): this {
        this.sessionOptions.caCertPath = caCertPath;
        return this;
    }

    /**
     * Set the client certificate path. enableTls() must also be called before
     * the build() method for this to be used.
     *
     * @param caCertPath The CA certificate path.
     */
    withClientCert(clientCertPath: fs.PathLike): this {
        this.sessionOptions.clientCertPath = clientCertPath;
        return this;
    }

    /**
     * Set the client private key path. enableTls() must also be called before
     * the build() method for this to be used.
     *
     * @param caCertPath The CA certificate path.
     */
    withClientKey(clientKeyPath: fs.PathLike): this {
        this.sessionOptions.clientKeyPath = clientKeyPath;
        return this;
    }

    withFormat(format: string): this {
        this.sessionOptions.format = format;
        return this;
    }
    /**
     * Build a new Session with the options that are set.
     *
     * @returns A new {@link Session}
     */
    build(): Session {
        return new Session(this.sessionOptions.makeCopy());
    }

    getSessionOptions(): SessionOptions {
        return this.sessionOptions.makeCopy();
    }
}

/**
 * An internal (not exported) class for holding various options
 * for creating a {@link Session}
 */
export class SessionOptions {
    /**
     * Address of the target NamedCache server.
     * @default localhost:1408.
     */
    address: string = SessionBuilder.DEFAULT_ADDRESS;

    /**
     * An option to define a Timeout for each call.
     * @default 60000 millis
     * @type {number}
     */
    requestTimeoutInMillis: number = 60000;

    /**
     * The IPv4 address of the Cloud Collections gRPC server.
     *
     * @default [process.env.TLS_ENABLED || false]
     */
    tlsEnabled = SessionOptions.toBoolean(process.env.TLS_ENABLED) || false;

    /**
     * The CA Certificate Paths (separated by ',').
     */
    caCertPath?: fs.PathLike;

    /**
     * The client certificate Path.
     */
    clientCertPath?: fs.PathLike;

    /**
     * The client Key.
     */
    clientKeyPath?: fs.PathLike;

    format: string = 'json';

    constructor() {
    }

    /**
     * Makes a copy of the options. Basically a clone method.
     *
     * @returns A new {@license SessionOptions}
     */
    makeCopy(): SessionOptions {
        const opts = new SessionOptions();
        opts.address = this.address;
        opts.tlsEnabled = this.tlsEnabled;
        opts.requestTimeoutInMillis = this.requestTimeoutInMillis;
        opts.caCertPath = this.caCertPath;
        opts.clientCertPath = this.clientCertPath;
        opts.clientKeyPath = this.clientKeyPath;
        opts.format = this.format;

        return opts;
    }

    static toBoolean(value?: string | number | boolean): boolean {
        return value ? [true, 'true', 'True', 'TRUE', '1', 1].includes(value) : false;
    }
}


export class Session
    extends EventEmitter {

    /**
     * A flag to indicate if Session.close() has been invoked.
     * @see waitForClosed() 
     * @see isClosed()
     */
    private markedForClose: boolean = false;

    private closed: boolean = false;

    /**
     * An internal cache of cache name to {@link NamedCacheClient}.
     */
    private caches = new Map<string, NamedCacheClient>();

    /**
     * The {@link SessionOptions} used while creating this {@link Session}.
     */
    private sessionOptions: SessionOptions;

    /**
     * The {@link ChannelCredentials} to use. If TLS is not enabled,
     * this will be an insecure ChannelCredentials.
     */
    private channelCredentials: ChannelCredentials;

    /**
     * The (shared) {@link Channel} to use for all the
     * {@link NamedCacheClient} that are created from this
     * {@link Session}.
     */
    private channel: grpc.Channel;

    /**
     * The set of options to use while creating a {@link Channel}.
     * See here for the list of possible options:
     *  https://grpc.github.io/grpc/core/group__grpc__arg__keys.html
     */
    private channelOptions: { [key: string]: string | number } = {};

    /**
     * The set of options to use while creating a {@link NamedCacheClient}.
     * One of the options will be the 'channelOverride' option to indicate
     * that the specified {@link Channel} must be used rather than creating
     * a new {@linkj Channel}.
     */
    private clientOptions: object = {};

    private sessionClosedPromise: Promise<boolean>;

    constructor(sessionOptions: SessionOptions) {
        super();
        this.sessionOptions = sessionOptions;

        // If TLS is enabled then create a SSL channel credentials object.
        if (this.sessionOptions.tlsEnabled) {
            const caCertBytes = Session.readFile("caCert", this.sessionOptions.caCertPath);
            const clientKeyBytes = Session.readFile("clientKey", this.sessionOptions.clientKeyPath);
            const clientCertBytes = Session.readFile("clientCert", this.sessionOptions.clientCertPath);

            this.channelCredentials = grpc.credentials.createSsl(caCertBytes, clientKeyBytes, clientCertBytes)
        } else {
            // tls not enabled. So use insecure channel credentials
            // which is same as plain transport channel.
            this.channelCredentials = grpc.credentials.createInsecure();
        }

        this.channelOptions = {
            // Interceptors can be specified here....
        };

        // Note: A Channel is just a logical concept. The creation of a physical
        // connection is handled by the gRPC core layer.
        this.channel = new grpc.Channel(this.sessionOptions.address, this.channelCredentials, this.channelOptions);

        // Now specify the just created Channel in the options so that
        // all {link NamedCacheServiceClient} share the same channel.
        this.clientOptions = {
            'channelOverride': this.channel
        }

        const self = this;
        this.sessionClosedPromise = new Promise((resolve, reject) => {
            self.on('event', (eventName: string, cacheName: string) => {
                if (self.markedForClose && self.caches.size == 0) {
                    self.closed = true;
                    resolve(true);
                }
            })
        })
    }

    getSessionOptions(): SessionOptions {
        return this.sessionOptions.makeCopy();
    }

    getAddress(): string {
        return this.sessionOptions.address;
    }

    getChannelCredentials(): ChannelCredentials {
        return this.channelCredentials;
    }

    getChannel(): grpc.Channel {
        return this.channel;
    }

    getActiveCacheCount(): number {
        return this.caches.size;
    }

    getActiveCaches(): Array<NamedCacheClient> {
        const array = new Array<NamedCacheClient>();
        for (let cache of this.caches.values()) {
            array.push(cache);
        }
        return array;
    }

    getActiveCacheNames(): Set<string> {
        const set = new Set<string>();
        for (let cache of this.caches.values()) {
            set.add(cache.getCacheName());
        }
        return set;
    }

    getClientOptions(): object {
        return this.clientOptions;
    }

    /**
     * An internal method to read a cert file given its path.
     *
     * @param certType  The type of the certificate. Used only while
     *                  creating an error message.
     * @param nameOrURL The path or URL to the cert.
     *
     * @returns The {@link Buffer} containing the certificate.
     */
    private static readFile(certType: string, nameOrURL?: fs.PathLike): Buffer {
        if (!nameOrURL) {
            throw new Error("When TLS is enabled, " + certType + " cannot be undefined or null");
        }
        return fs.readFileSync(nameOrURL);
    }

    /**
     * Returns a {@link NamedCacheClient} for the specified cache name. This class
     * maintains an internal cache (a Map) and if a {@link NamedCacheClient} exists
     * in the cache it is returned. Else a new {@link NamedCacheClient} is created
     * (then cached) and returned.
     *
     * @param name Returns a {@link NamedCacheClient} for the specified name.
     */
    getCache<K, V>(name: string, format?: string): NamedCacheClient<K, V> {
        if (this.markedForClose) {
            throw new Error('Session already closed');
        }

        format = format ? format : SessionBuilder.DEFAULT_FORMAT;
        const cacheKey = Session.makeCacheKey(name, format);
        const serializer = SerializerRegistry.instance().serializer(format);

        let namedCache = this.caches.get(cacheKey);
        if (!namedCache) {
            namedCache = new NamedCacheClient(name, this, serializer, this.setupEventHandlers);
            this.caches.set(cacheKey, namedCache);
        }

        return namedCache;
    }

    private static makeCacheKey(cacheName: string, format: string): string {
        return cacheName + ':' + format;
    }

    private static isKeyForCacheName(key: string, cacheName: string): boolean {
        return key.startsWith(cacheName + ':');
    }

    private setupEventHandlers(sess: Session, emitter: EventEmitter) {
        const self = sess;
        emitter.on('cache_destroyed', (cacheName: string) => {
            // Our keys in caches Map are of the form cacheName:format.
            // We will destroy all  cache destroy event is co
            for (let key of self.caches.keys()) {
                if (Session.isKeyForCacheName(key, cacheName)) {
                    self.caches.delete(key);
                    self.emit('cache_destroyed', cacheName);
                    self.emit('event', 'cache_destroyed', cacheName);
                }
            }
        });

        emitter.on('cache_released', (cacheName: string, format: string) => {
            self.caches.delete(Session.makeCacheKey(cacheName, format));
            self.emit('cache_released', cacheName, format);
            self.emit('event', 'cache_released', cacheName, format);
        });

        emitter.on('cache_closed', (cacheName: string, format: string) => {
            self.caches.delete(Session.makeCacheKey(cacheName, format));
            self.emit('cache_closed', cacheName, format);
            self.emit('event', 'cache_closed', cacheName, format);
        });
    }

    /**
     * Close the {@link Session}.
     */
    async close(): Promise<void> {
        if (this.markedForClose) {
            return;
        }

        this.markedForClose = true;
        for (let entry of this.caches.entries()) {
            await entry[1].release();
        }

        this.channel.close();
    }

    isClosed(): boolean {
        return this.closed;
    }

    waitUntilClosed(): Promise<boolean> {
        return this.sessionClosedPromise;
    }

}