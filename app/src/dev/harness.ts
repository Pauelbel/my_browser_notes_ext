// dev.html: exposes the page layer as window.layer for the e2e scenarios in tests/e2e.
const layer = {
  ping: () => 'pong',
};
Object.assign(window, {layer});
