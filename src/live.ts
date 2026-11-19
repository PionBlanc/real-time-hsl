/**
 * Live vehicle positions from every feed, over one MQTT connection per broker.
 * A broker is only connected once something on it is wanted (someone in Helsinki never
 * connects to mqtt.digitransit.fi), and stays connected while the page is visible.
 */
import type { City } from '../api/_cities'
import type { Feed, Msg } from './feed'
import { hfp } from './hfp'
import { gtfsrt } from './gtfsrt'
import { MqttClient } from './mqtt'
import type { MqttStatus } from './mqtt'

/** The live feed carrying each kind of city (City.live). */
export const FEEDS: Record<City['live'], Feed> = { hfp, gtfsrt }

export const feedOf = (city: City): Feed => FEEDS[city.live]

export class Live {
  private clients = new Map<Feed, MqttClient>()
  private running = false
  status: MqttStatus = 'connecting'

  constructor(
    private onMessage: (m: Msg) => void,
    private onStatus: (s: MqttStatus) => void,
  ) {}

  /** Declare the full set of topic filters wanted on each feed; feeds left out get none. */
  setTopics(byFeed: Map<Feed, Array<string>>): void {
    for (const [feed, topics] of byFeed) if (topics.length && !this.clients.has(feed)) this.connect(feed)
    for (const [feed, client] of this.clients) client.setTopics(byFeed.get(feed) ?? [])
    this.update()
  }

  start(): void {
    this.running = true
    for (const c of this.clients.values()) c.start()
  }

  /** Disconnect everything (the page is hidden). */
  stop(): void {
    this.running = false
    for (const c of this.clients.values()) c.stop()
  }

  private connect(feed: Feed): void {
    const c = new MqttClient(
      feed.broker,
      (topic, payload) => {
        const m = feed.parse(topic, payload)
        if (m) this.onMessage(m)
      },
      () => this.update(),
    )
    this.clients.set(feed, c)
    if (this.running) c.start()
  }

  /** One status for the app: live only when every connection is. */
  private update(): void {
    const all = [...this.clients.values()].map((c) => c.status)
    const s: MqttStatus = !all.length
      ? this.running ? 'online' : 'offline' // nothing wanted yet: nothing is missing
      : all.includes('offline') ? 'offline'
      : all.includes('connecting') ? 'connecting'
      : 'online'
    if (s === this.status) return
    this.status = s
    this.onStatus(s)
  }
}
