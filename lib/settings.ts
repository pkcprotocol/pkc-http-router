const settings = {
  /* TODO: once the POST spec is finalized, add interval and min interval to response, and remove peers after this time
    The Pirate Bay: Often uses an announce interval of 1800 seconds (30 minutes).
    1337x: May use similar intervals like 1800 seconds, with a minimum announce interval of around 300 seconds.
    Rutracker: Frequently employs announce intervals of 1800 seconds, and minimum intervals of around 300-600 seconds.
  */
  announceMinInterval: 1000 * 60 * 5, // 5min is the most common https://wiki.theory.org/BitTorrentSpecification#Tracker_Response
  announceInterval: 1000 * 60 * 30, // 15-30min is the most common https://wiki.theory.org/BitTorrentSpecification#Tracker_Response
  announceIntervalTimeout: 1000 * 60 * 30 // remove peer if no interval after this time, 15-30min is the most common https://wiki.theory.org/BitTorrentSpecification#Tracker_Response
}

export default settings
