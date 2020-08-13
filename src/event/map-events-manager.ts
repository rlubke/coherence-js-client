/*
 * Copyright (c) 2020 Oracle and/or its affiliates.
 *
 * Licensed under the Universal Permissive License v 1.0 as shown at
 * http://oss.oracle.com/licenses/upl.
 */

import { EventEmitter } from 'events'
import { ClientDuplexStream } from 'grpc'
import { MapEvent, MapListener } from '.'
import { AlwaysFilter, MapEventFilter } from '../filter'
import { NamedMap } from '../net'
import { MapListenerRequest, MapListenerResponse } from '../net/grpc/messages_pb'
import { NamedCacheServiceClient } from '../net/grpc/services_grpc_pb'
import { Serializer, Map } from '../util/'
import { RequestFactory } from '../util/request-factory' // RequestFactory not exported
import { CacheLifecycleEvent } from './events'

type SubscriptionCallback = (uid: string, cookie: any, err?: Error | undefined) => void;

/**
 * MapEventsManager handles registration, de-registration of {@link MapListener}, and
 * notification of {@link MapEvent}s to {@link MapListener}. Since multiple
 * MapListeners can be registered for a single key / filter, this class
 * relies on another internal class called ListenerGroup which maintains the
 * collection of MapListeners.
 *
 * There are two maps that are maintained:
 *
 * 1. A Map of stringified key => ListenerGroup, which is used to identify the
 * group of MapListeners for a single key. We stringify the key since Javascript
 * is not the same as Java's equals().
 *
 * 2. A Map of filter => ListenerGroup that is used to identify the group of
 * MapListeners for a MapEventFilter.
 *
 * When a filter is subscribed, the server responds with a unique filterID.
 * This filterID is what is specified is a MapEvent. So, this class maintains
 * a third Map of filterID to ListenerGroup for efficiently identifying the
 * ListenerGroup for a filterID.
 *
 * This class also lazily creates the "events" stream (a bidi stream). When
 * the first listener is registered, this class calls the "events()" method
 * on the NamedCacheClient and obtains the duplex stream. Similarly, it
 * closes the stream when the last listener is unregistered.
 *
 * Note:- Javascript Maps use only the object identity to check for equality
 * of keys in a Map.  This is fine for Maps that use primitive and strings
 * as keys. But for complex key objects, this wont work as a deserialized
 * object's identity wont be the same as the original object. So, this
 * class uses a method called stringify(obj) that converts the specified
 * object into a stringified form. Currently, this is implemented by just
 * using JSON,.stringify() method.
 *
 * @internal
 */
export class MapEventsManager<K, V> {
  /**
   * A singleton for a resolved Promise.
   */
  private static RESOLVED = Promise.resolve()

  /**
   * A singleton MapEventFilter for an Always filter.
   */
  private static DEFAULT_FILTER = new MapEventFilter(MapEventFilter.E_ALL, AlwaysFilter.INSTANCE)

  /**
   * The map name for which events are received.
   */
  protected mapName: string

  /**
   * The gRPC service client.
   */
  protected client: NamedCacheServiceClient

  /**
   * The `NamedMap` that will used as the *source* of the events.
   */
  protected namedMap: NamedMap<K, V>

  /**
   * Request factory.
   */
  protected reqFactory: RequestFactory<K, V>

  /**
   * A Promise for lazily creating the duplex stream. The streamPromise
   * will resolve to a ClientDuplexStream<MapListenerRequest, MapListenerResponse>
   * that will be used by this class to send subscriptions and to receive all events.
   */
  private streamPromise: Promise<ClientDuplexStream<MapListenerRequest, MapListenerResponse>> | null = null

  /**
   * Used to track if a cancel call was due to this object
   * initiating a channel close.
   */
  private markedForClose = false

  /**
   * A Map containing the outstanding subscriptions. When the corresponding
   * MapListenerResponse is received (for a SubscriptionRequest) then the
   * registered callback is invoked.
   */
  private pendingSubscriptions = new Map<string, SubscriptionCallback>()

  /**
   * The Map of keys => set of listeners (ListenerGroup).
   */
  private keyMap: Map<K, ListenerGroup<K, V>>

  /**
   * The Map of MapEventFilter => set of listeners (ListenerGroup).
   */
  private filterMap: Map<MapEventFilter<K, V>, ListenerGroup<K, V>>

  /**
   * A Map of filter ID =>  ListenerGroup.
   */
  private filterId2ListenerGroup: Map<number, ListenerGroup<K, V>>

  /**
   * The serializer to apply when ser/deser map events.
   */
  private readonly serializer: Serializer

  /**
   * The {@link EventEmitter}.
   */
  private emitter: EventEmitter

  /**
   * Constructs a new `MapEventsManager`
   *
   * @param namedMap    the {@link NamedMap} to manage events for
   * @param client      the `gRPC` interface for making requests
   * @param serializer  the {@link Serializer} used by this map
   * @param emitter     the {@link EventEmitter} to use
   */
  constructor (namedMap: NamedMap<K, V>, client: NamedCacheServiceClient, serializer: Serializer, emitter: EventEmitter) {
    this.mapName = namedMap.name
    this.client = client
    this.namedMap = namedMap
    this.serializer = serializer
    this.emitter = emitter

    // Initialize internal data structures.
    this.keyMap = new Map()
    this.filterMap = new Map()
    this.filterId2ListenerGroup = new Map()
    this.reqFactory = new RequestFactory(this.mapName, serializer)
    this.streamPromise = this.ensureStream()
  }

  /**
   * Create a BiDi stream lazily.
   */
  ensureStream (): Promise<ClientDuplexStream<MapListenerRequest, MapListenerResponse>> {
    const self = this
    if (self.streamPromise == null) {
      const bidiStream = self.client.events()

      bidiStream.on('data', (resp) => self.handleResponse(resp))
      bidiStream.on('end', () => self.onEnd())
      bidiStream.on('error', (err) => self.onError(err))
      bidiStream.on('cancelled', () => self.onCancel())

      // Create a SubscribeRequest (with RequestType.INIT)
      const request = self.reqFactory.mapEventSubscribe()
      const initUid = request.getUid()
      self.streamPromise = new Promise((resolve, reject) => {
        // Setup pending subscriptions map so that when the
        // subscribe response comes back, or an error occurs
        // we can resolve or reject the connection.
        self.pendingSubscriptions.set(initUid, (uid, resp, err) => {
          self.pendingSubscriptions.delete(uid)
          if (err) {
            reject(err)
          } else {
            // If we received a successful subscribed response,
            // the connection is initialized. So resolve it.
            resolve(bidiStream)
          }
        })

        // Now that we have set up the pending subscriptions map,
        // write the init request.
        bidiStream.write(request)
      })
    }

    return self.streamPromise
  }

  /**
   * Process incoming `gRPC` {@link MapListenerResponse}s.
   *
   * @param resp  the {@link MapListenerResponse} to process
   */
  handleResponse (resp: MapListenerResponse) {
    switch (resp.getResponseTypeCase()) {
      case MapListenerResponse.ResponseTypeCase.SUBSCRIBED:
      case MapListenerResponse.ResponseTypeCase.UNSUBSCRIBED:
        const uid = resp.hasSubscribed()
          ? resp.getSubscribed()?.getUid()
          : resp.getUnsubscribed()?.getUid()

        if (uid) {
          const callback = this.pendingSubscriptions.get(uid)
          this.pendingSubscriptions.delete(uid)
          if (callback) {
            callback(uid, resp)
          }
        }
        break

      case MapListenerResponse.ResponseTypeCase.DESTROYED:
        if (resp.hasDestroyed() && resp.getDestroyed()?.getCache() == this.mapName) {
          this.emitter.emit(CacheLifecycleEvent.DESTROYED, this.mapName)
        }
        break

      case MapListenerResponse.ResponseTypeCase.TRUNCATED:
        if (resp.hasTruncated() && resp.getTruncated()?.getCache() == this.mapName) {
          this.emitter.emit(CacheLifecycleEvent.TRUNCATED, this.mapName)
        }
        break

      case MapListenerResponse.ResponseTypeCase.EVENT:
        if (resp.hasEvent()) {
          const event = resp.getEvent()
          if (event) {
            const mapEvent = new MapEvent(this.mapName, this.namedMap, event, this.serializer)

            for (const id of event.getFilteridsList()) {
              const group = this.filterId2ListenerGroup.get(id)

              if (group) {
                group.notifyListeners(mapEvent)
              }
            }

            const keyGroup = this.keyMap.get(mapEvent.getKey())
            if (keyGroup) {
              keyGroup.notifyListeners(mapEvent)
            }
          }
        }
        break
    }
  }

  /**
   * Registers the specified listener to listen for events matching the provided key.
   *
   * @param listener  the {@link MapListener}
   * @param key       the map key to listen to
   * @param isLite    `true` if the event should only include the key, or `false`
   *                  if the event should include old and new values as well as the key
   */
  registerKeyListener (listener: MapListener<K, V>, key: K, isLite: boolean = false): Promise<void> {
    let group = this.keyMap.get(key)
    if (!group) {
      group = new KeyListenerGroup(this, key)
      this.keyMap.set(key, group)
    }

    return group.addListener(listener, isLite)
  }

  /**
   * Removes the registration of the listener for the provided key.
   *
   * @param listener  the listener to remove
   * @param key       the key associated with the listener
   */
  removeKeyListener (listener: MapListener<K, V>, key: K): Promise<void> {
    const group = this.keyMap.get(key)
    if (group) {
      return group.removeListener(listener)
    }

    return MapEventsManager.RESOLVED
  }

  /**
   * Registers the specified listener to listen for events matching the provided filter.
   *
   * @param listener   the {@link MapListener}
   * @param mapFilter  the {@link filter} associated with the listener
   * @param isLite     `true` if the event should only include the key, or `false`
   *                   if the event should include old and new values as well as the key
   */
  registerFilterListener (listener: MapListener<K, V>, mapFilter: MapEventFilter<K, V> | null, isLite: boolean = false): Promise<void> {
    const filter = mapFilter == null ? MapEventsManager.DEFAULT_FILTER : mapFilter

    let group = this.filterMap.get(filter)
    if (!group) {
      group = new FilterListenerGroup(this, filter)
      this.filterMap.set(filter, group)
    }

    return group.addListener(listener, isLite)
  }

  /**
   * Removes the registration of the listener for the provided filter.
   *
   * @param listener   the listener to remove
   * @param mapFilter  the {@link MapEventFilter} associated with the listener
   */
  removeFilterListener (listener: MapListener<K, V>, mapFilter: MapEventFilter<K, V> | null): Promise<void> {
    const filter = mapFilter == null ? MapEventsManager.DEFAULT_FILTER : mapFilter

    const group = this.filterMap.get(filter)
    if (!group) {
      return MapEventsManager.RESOLVED
    }

    return group.removeListener(listener)
  }

  /**
   * Write the provided `gRPC` {@link MapListenerRequest}.
   *
   * @param request the {@link MapListenerRequest}
   *
   */
  writeRequest (request: MapListenerRequest): Promise<void> {
    const self = this
    return this.ensureStream()
      .then((stream: ClientDuplexStream<MapListenerRequest, MapListenerResponse>) => {
        return new Promise<void>((resolve, reject) => {
          self.pendingSubscriptions.set(request.getUid(), (uid, resp, err) => {
            self.pendingSubscriptions.delete(uid)
            if (err) {
              reject(err)
            } else {
              resolve()
            }
          })
          stream.write(request)
        })
      })
  }

  /**
   * Close this event stream.
   */
  async closeEventStream (): Promise<void> {
    const self = this
    if (!self.markedForClose && self.streamPromise != null) {
      self.markedForClose = true
      const bidiStream = await self.streamPromise
      await new Promise(async (resolve) => {
        // Setup an event handler for 'error' as calling cancel() on
        // the bidi stream will result in a CANCELLED status.
        bidiStream.on('error', (err) => {
          if (err.toString().indexOf('CANCELLED')) {
            self.streamPromise = null
            resolve()
          }
        })
        bidiStream.cancel()
      })
    }
    return Promise.resolve()
  }

  /**
   * Remove key from key group.
   *
   * @param key the key to remove
   */
  keyGroupUnsubscribed (key: K): void {
    this.keyMap.delete(key)
  }

  /**
   * Add the filter ID and the group to the ID -> group mapping.
   *
   * @param filterId  the filter ID
   * @param group     the listener group
   */
  filterGroupSubscribed (filterId: number, group: ListenerGroup<K, V>): void {
    this.filterId2ListenerGroup.set(filterId, group)
  }

  /**
   * Unsubscribe the filter ID and filter from their associated maps.
   *
   * @param filterId  the filter ID
   * @param filter    the filter
   */
  filterGroupUnsubscribed (filterId: number, filter: MapEventFilter<K, V>): void {
    this.filterId2ListenerGroup.delete(filterId)
    this.filterMap.delete(filter)
  }

  /**
   * Handles stream errors.
   *
   * @param err  the stream error
   */
  private onError (err: Error) {
    if (!this.markedForClose) {
      this.emitter.emit('error', this.mapName + ': Received onError', err)
    }
  }

  /**
   * Handles the end of an event stream.
   */
  private onEnd () {
    if (!this.markedForClose) {
      this.emitter.emit('error', this.mapName + ': Received onEnd')
    }
  }

  /**
   * Handles a stream being cancelled.
   */
  private onCancel () {
    if (!this.markedForClose) {
      this.emitter.emit('error', '** Received onCancel')
    }
  }
}

/**
 * Manages a collection of MapEventListeners. Handles sending out
 * MapListenerRequest subscriptions / unsubscriptions.  Also, handles
 * notification of all the registered listeners.
 */
abstract class ListenerGroup<K, V> {
  /**
   * Internal: A singleton resolved Promise.
   */
  private static RESOLVED = Promise.resolve()

  /**
   * Active status will be true if the subscribe request has been sent.
   * It will be false if a unsubscribe request has been sent.
   */
  isActive: boolean = true // Initially active.

  /**
   * The key or the filter for which this group of MapListener will
   * receive events.
   */
  keyOrFilter: K | MapEventFilter<K, V>

  /**
   * The current value of isLite that is registered with the cache.
   * If a new listener is added to the group that requires isLite == false
   * but if the registeredIsLite is true, then a re-registration occurs.
   *
   * Similarly if a listener is removed whose isLite == false but if all the
   * remaining listeners are interested in only isLite == true, then a
   * re-registration occurs.
   */
  registeredIsLite: boolean = true

  /**
   * A map of all listeners in this group. Each listener has a isLite
   * flag.
   */
  listeners: Map<MapListener<K, V>, { isLite: boolean }> = new Map()

  /**
   * Number of MapListeners who are registered with isLite == false.
   * If this transitions from zero to non-zero (or vice versa), then
   * a re-registration happens is the current registeredIsLite is true.
   */
  isLiteFalseCount: number = 0

  /**
   * Reference to MapEventsManager.
   */
  helper: MapEventsManager<K, V>

  /**
   * Constructs a new `ListenerGroup`.
   *
   * @param helper       the {@link MapEventsManager}
   * @param keyOrFilter  the key or filter for this group of listeners
   */
  protected constructor (helper: MapEventsManager<K, V>, keyOrFilter: K | MapEventFilter<K, V>) {
    this.helper = helper
    this.keyOrFilter = keyOrFilter
  }

  /**
   * Add a MapListener to this group. This causes a subscription message
   * to be sent through the stream if (a) either this is the first
   * listener, or (b) the isLite param is false but all the previous
   * listeners have isLite == true.
   *
   * @param listener  the {@link MapListener} to add
   * @param isLite    `true` if the event should only include the key, or `false`
   *                  if the event should include old and new values as well as the key
   */
  async addListener (listener: MapListener<K, V>, isLite: boolean): Promise<void> {
    // Check if this Listener is already registered.
    const prevStatus = this.listeners.get(listener)

    if (prevStatus && prevStatus.isLite == isLite) {
      // This listener is registered with the same isLite status.
      // So, nothing to do.
      return ListenerGroup.RESOLVED
    }

    this.listeners.set(listener, {isLite})
    if (!isLite) {
      this.isLiteFalseCount++
    }

    // We need registration request only if the current
    // set of listeners are all using isLite == true, but
    // the new listener is requesting isLite = false. So we need to
    // send a new registration request with the new isLite flag.
    const requireRegistrationRequest = this.listeners.size == 1 || this.registeredIsLite && !isLite
    const self = this

    if (requireRegistrationRequest) {
      this.registeredIsLite = isLite
      if (this.listeners.size > 1) {
        // A change in isLite; So need to do re-registration
        await self.doUnsubscribe()
      }
      await self.doSubscribe(isLite)
    }

    return ListenerGroup.RESOLVED
  }

  /**
   * Remove the specified {@link MapListener} from this group.
   *
   * @param listener  the {@link MapListener} to be removed.
   */
  async removeListener (listener: MapListener<K, V>): Promise<void> {
    const prevStatus = this.listeners.get(listener)
    if (!prevStatus || this.listeners.size == 0) {
      // This listener was never registered.
      return ListenerGroup.RESOLVED
    }

    this.listeners.delete(listener)

    if (this.listeners.size == 0) {
      // This was the last MapListener.
      return await this.doUnsubscribe()
    }

    if (!prevStatus.isLite) {
      // We removed a isLite == false MapListener.
      this.isLiteFalseCount--

      if (this.isLiteFalseCount == 0) {
        await this.doUnsubscribe()
        await this.doSubscribe(true /* isLite is true */)
      }
    }

    return ListenerGroup.RESOLVED
  }

  /**
   * Send a `gRPC` {@link MapListenerRequest} to subscribe the key or filter.
   *
   * @param isLite `true` if the event should only include the key, or `false`
   *               if the event should include old and new values as well as the key
   */
  async doSubscribe (isLite: boolean): Promise<void> {
    // @ts-ignore
    const request = this.helper.reqFactory.mapListenerRequest(true, this.keyOrFilter, isLite)
    await this.helper.writeRequest(request)
    this.postSubscribe(request)
  }

  /**
   * Send a `gRPC` {@link MapListenerRequest} to unsubscribe the key or filter.
   */
  async doUnsubscribe (): Promise<void> {
    // @ts-ignore
    const request = this.helper.reqFactory.mapListenerRequest(false, this.keyOrFilter)
    await this.helper.writeRequest(request)

    this.postUnsubscribe(request)
  }

  /**
   * Notify all relevant listeners with the provided event.
   *
   * @param mapEvent the {@link MapEvent}
   */
  notifyListeners (mapEvent: MapEvent): void {
    for (const listener of this.listeners.keys()) {
      switch (mapEvent.getId()) {
        case MapEvent.ENTRY_DELETED:
          listener.entryDeleted(mapEvent)
          break
        case MapEvent.ENTRY_INSERTED:
          listener.entryInserted(mapEvent)
          break
        case MapEvent.ENTRY_UPDATED:
          listener.entryUpdated(mapEvent)
          break
      }
    }
  }

  /**
   * Custom actions that implementations may need to make after a subscription has been completed.
   *
   * @param request the {@link MapListenerRequest} that was used to subscribe
   */
  abstract postSubscribe (request: MapListenerRequest): void;

  /**
   * Custom actions that implementations may need to make after an unsubscription has been completed.
   *
   * @param request the {@link MapListenerRequest} that was used to unsubscribe
   */
  abstract postUnsubscribe (request: MapListenerRequest): void;
}

/**
 * A {@link ListenerGroup} for key-based listeners.
 * @internal
 */
class KeyListenerGroup<K, V>
  extends ListenerGroup<K, V> {

  /**
   * Constructs a new `KeyListenerGroup`.
   *
   * @param helper  the {@link MapEventsManager}
   * @param key     they group key
   */
  constructor (helper: MapEventsManager<K, V>, key: K) {
    super(helper, key)
  }

  /**
   * @inheritDoc
   */
  postSubscribe (request: MapListenerRequest): void {
  }

  /**
   * @inheritDoc
   */
  postUnsubscribe (request: MapListenerRequest): void {
    // @ts-ignore
    const key = this.helper.serializer.deserialize(request.getKey())
    this.helper.keyGroupUnsubscribed(key)
  }
}

/**
 * A {@link ListenerGroup} for filter-based listeners.
 * @internal
 */
class FilterListenerGroup<K, V>
  extends ListenerGroup<K, V> {
  /**
   * Constructs a new `KeyListenerGroup`.
   *
   * @param helper  the {@link MapEventsManager}
   * @param filter  the group filter
   */
  constructor (helper: MapEventsManager<K, V>, filter: MapEventFilter<K, V>) {
    super(helper, filter)
  }

  /**
   * @inheritDoc
   */
  postSubscribe (request: MapListenerRequest): void {
    this.helper.filterGroupSubscribed(request.getFilterid(), this)
  }

  /**
   * @inheritDoc
   */
  postUnsubscribe (request: MapListenerRequest): void {
    this.helper.filterGroupUnsubscribed(request.getFilterid(), this.keyOrFilter as MapEventFilter<K, V>)
  }
}
