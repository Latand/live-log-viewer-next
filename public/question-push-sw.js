self.addEventListener("push", (event) => {
  let payload = {
    title: "Агент чекає відповіді",
    body: "Відкрий переглядач логів, щоб відповісти.",
    url: "/",
  };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    /* generic fallback above */
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: "agent-question",
      data: { url: payload.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("navigate" in client && "focus" in client) return client.navigate(url).then((navigated) => (navigated || client).focus());
      }
      return self.clients.openWindow(url);
    }),
  );
});
