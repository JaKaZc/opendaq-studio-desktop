/* The openDAQ Studio engine's C interface.
 *
 * The phone app calls it through Dart FFI and the desktop app through its
 * Node addon. Requests use the routes and JSON shapes of openDAQ Studio's API
 * (docs/API.md of openDAQ Studio). Every pointer the engine returns is freed with
 * studio_free.
 */

#ifndef STUDIO_ENGINE_H
#define STUDIO_ENGINE_H

#include <stdint.h>

#if defined(_WIN32)
#define STUDIO_IMPORT __declspec(dllimport)
#else
#define STUDIO_IMPORT
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* Starts the openDAQ instance. `options` is JSON, see studio_start in
 * src/engine.cpp. Returns 0, or -1 with the reason in studio_last_error. */
STUDIO_IMPORT int studio_start(const char* options);
STUDIO_IMPORT char* studio_last_error(void);
STUDIO_IMPORT void studio_stop(void);

/* One API request. `query` and `body` are JSON or empty. `status` receives
 * the HTTP-style status; the result is the JSON answer. */
STUDIO_IMPORT char* studio_request(const char* method, const char* path, const char* query, const char* body, int* status);

/* Live data for the phone app: the signals to stream as a JSON list of global
 * IDs, the points per second, and each poll's samples as one ODQV frame, or
 * null. */
STUDIO_IMPORT void studio_subscribe(const char* ids, int pointsPerSecond);
STUDIO_IMPORT void studio_set_resolution(int pointsPerSecond);
STUDIO_IMPORT uint8_t* studio_poll(int* length);

/* Live data for several clients, such as desktop windows: each has its own
 * signals, resolution and cursor. studio_client_subscribe answers the
 * signals' metadata as {"signals": [...]}; `ids` is a JSON list, and null
 * in studio_client_unsubscribe means all. */
STUDIO_IMPORT int studio_client_open(void);
STUDIO_IMPORT void studio_client_close(int client);
STUDIO_IMPORT char* studio_client_subscribe(int client, const char* ids, double pointsPerSecond, double primeSeconds, int* status);
STUDIO_IMPORT void studio_client_unsubscribe(int client, const char* ids);
STUDIO_IMPORT void studio_client_resolution(int client, double pointsPerSecond);
STUDIO_IMPORT void studio_client_pause(int client, int paused);
STUDIO_IMPORT uint8_t* studio_client_poll(int client, int* length);

/* Core events since the last call, as a JSON list of {type, payload}. */
STUDIO_IMPORT char* studio_events(void);

/* The newest picture of an image signal if newer than `known`, or null. */
STUDIO_IMPORT uint8_t* studio_image(const char* id, int64_t known, int* length, int64_t* sequence);

STUDIO_IMPORT void studio_free(void* pointer);

#ifdef __cplusplus
}
#endif

#endif
