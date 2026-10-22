/**
 * Wi-Fi channel lock + ESP-NOW bridge between WebHID (TinyUSB) and robots.
 * Protocol: firmware/common/minicore_protocol.h (docs/MINICORE_CLAUDE.md).
 */

#include "minicore_bridge.h"

#include <string.h>

#include "esp_err.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_now.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "minicore_protocol.h"
#include "tusb.h"

static const char *TAG = "mc_bridge";

static uint8_t s_channel = 11;
static volatile bool s_global_enabled;

/* ESP-NOW send failures are reported asynchronously in espnow_send_cb, long
 * after esp_now_send() has already returned ESP_OK. A single "did it fail" bit
 * therefore races anything that resets it: the flag would be set microseconds
 * after each send and cleared on the next one, so a status sampler would catch
 * it only by luck and the fault would flicker rather than hold.
 *
 * Report the fault from recent history instead. All timestamps below are
 * esp_timer microseconds, 0 meaning "never", and a fault reads as set while the
 * most recent outcome was a failure within MC_SEND_ERR_HOLD_US. The hold is well
 * over the 200 ms status-task period, so an unreachable robot reads as steadily
 * failing rather than blinking, and a recovered link clears on its next success.
 *
 * The history is per paired slot, not global. Joystick traffic is unicast per
 * robot at up to 50 Hz, so with one robot dead and another alive a single shared
 * pair of timestamps would interleave successes and failures and flicker exactly
 * as the old single bit did.
 *
 * A slot is only in fault once nothing has got through to it for
 * MC_SEND_FAULT_US. A single lost frame is superseded by the next one 20-100 ms
 * later and the robot never notices, so reporting it -- which "most recent
 * outcome was a failure" did -- raised warnings for drops nobody could act on.
 * The threshold matches the robot's MC_MOTOR_TIMEOUT_MS failsafe
 * (minicore_policy.h, not included here because the dongle must not depend on
 * policy): past it the robot has stopped its motors, so the driver felt it.
 * Isolated drops still show up, as counts in dongle_status_t.tx_fail[]. */
#define MC_SEND_ERR_HOLD_US 1000000 /* 1 s */
#define MC_SEND_FAULT_US 250000     /* 250 ms, = robot MC_MOTOR_TIMEOUT_MS */
static volatile int64_t s_slot_err_us[MC_MAX_ROBOTS];
static volatile int64_t s_slot_ok_us[MC_MAX_ROBOTS];
/* Start of the slot's current run of failures, 0 = not failing. */
static volatile int64_t s_slot_fail_since_us[MC_MAX_ROBOTS];
/* Free-running, wrapping counters for the station: unicast frames a robot never
 * acknowledged, and sends the dongle could not even queue (peer table full,
 * radio busy). The two point at different causes -- RF versus the dongle
 * itself -- which is the whole reason to report them separately. */
static volatile uint16_t s_slot_fail_n[MC_MAX_ROBOTS];
static volatile uint16_t s_sync_err_n;
/* Failures on the broadcast paths (enable, discovery), which esp_now_send()
 * reports synchronously. Broadcasts have no meaningful completion status, so
 * nothing ever arrives to clear this; it ages out on the same hold instead. A
 * persistent fault keeps being refreshed, because the station re-asserts enable
 * about every 500 ms while armed. */
static volatile int64_t s_bcast_err_us;
static uint8_t s_paired_mac[MC_MAX_ROBOTS][6];
static bool s_paired_valid[MC_MAX_ROBOTS];
static bool s_discovery_active;
static esp_timer_handle_t s_disc_timer;

/* Joystick frames are not sent from the USB callback. They used to be, one
 * esp_now_send() per HID report with no regard for whether the last frame had
 * left yet, and the Wi-Fi driver queues every frame for every peer in a single
 * FIFO. With two robots the station's report rate outran the radio: a robot
 * needing MAC retries held the queue, the other robot's frames waited behind it,
 * and robots drove on stick values up to ~2 s old while the queue overflowed
 * into send failures.
 *
 * Now each slot holds only its newest frame, and joystick_tx_task sends it once
 * that slot's previous frame has completed. At most one joystick frame per robot
 * is ever in the radio, so nothing queues and a frame is never older than one
 * send. A frame overwritten while waiting was stale anyway; the robot only ever
 * wants the latest sticks.
 *
 * s_tx_lock guards the pending frames, the in-flight stamps and the pairing
 * table, which the USB task, the Wi-Fi task (send callback) and the tx task all
 * touch. */
static portMUX_TYPE s_tx_lock = portMUX_INITIALIZER_UNLOCKED;
static joystick_packet_t s_tx_pending[MC_MAX_ROBOTS];
static bool s_tx_pending_valid[MC_MAX_ROBOTS];
/* When the slot's in-flight frame was handed to esp_now_send, 0 = none. A
 * SET_NEUTRAL to the same peer completes through the same callback and can clear
 * this early; that only ever lets a second frame into the radio, never zero. */
static int64_t s_tx_inflight_us[MC_MAX_ROBOTS];
/* Backstop in case a completion never arrives (e.g. the peer was unpaired
 * between send and callback), so a slot cannot stall forever. Far longer than a
 * unicast with its full retry budget takes. */
#define MC_TX_INFLIGHT_TIMEOUT_US 100000 /* 100 ms */
static TaskHandle_t s_tx_task;

/* Record a unicast outcome for a slot. Called from the Wi-Fi task (completions)
 * and the tx and USB tasks (synchronous failures), hence the lock: the 64-bit
 * stamps are not atomic on this core. */
static void slot_note_ok(int slot, int64_t now)
{
    taskENTER_CRITICAL(&s_tx_lock);
    s_slot_ok_us[slot] = now;
    s_slot_fail_since_us[slot] = 0;
    taskEXIT_CRITICAL(&s_tx_lock);
}

static void slot_note_fail(int slot, int64_t now)
{
    taskENTER_CRITICAL(&s_tx_lock);
    /* A run that went quiet for longer than the hold (the field was disabled,
     * so nothing was sent) is over; don't let it make the next failure look
     * like an instant 250 ms outage. */
    if (s_slot_fail_since_us[slot] == 0 || now - s_slot_err_us[slot] > MC_SEND_ERR_HOLD_US) {
        s_slot_fail_since_us[slot] = now;
    }
    s_slot_err_us[slot] = now;
    taskEXIT_CRITICAL(&s_tx_lock);
}

/* A send that failed before reaching the air: counted apart from NAKs. */
static void slot_note_sync_fail(int slot, int64_t now)
{
    s_sync_err_n++;
    slot_note_fail(slot, now);
}

static void bcast_note_sync_fail(void)
{
    s_sync_err_n++;
    s_bcast_err_us = esp_timer_get_time();
}

static void discovery_timer_cb(void *arg)
{
    (void)arg;
    s_discovery_active = false;
    ESP_LOGI(TAG, "discovery window end");
}

static const uint8_t k_broadcast_mac[6] = {MC_BROADCAST_MAC_BYTE, MC_BROADCAST_MAC_BYTE,
                                           MC_BROADCAST_MAC_BYTE, MC_BROADCAST_MAC_BYTE,
                                           MC_BROADCAST_MAC_BYTE, MC_BROADCAST_MAC_BYTE};

static bool is_broadcast_mac(const uint8_t *mac)
{
    return memcmp(mac, k_broadcast_mac, 6) == 0;
}

static esp_err_t ensure_broadcast_peer(void)
{
    if (esp_now_is_peer_exist(k_broadcast_mac)) {
        return ESP_OK;
    }
    esp_now_peer_info_t p = {0};
    memcpy(p.peer_addr, k_broadcast_mac, 6);
    p.channel = s_channel;
    p.ifidx = WIFI_IF_STA;
    p.encrypt = false;
    esp_err_t e = esp_now_add_peer(&p);
    /* Another task may have added it between the check and the add. */
    return e == ESP_ERR_ESPNOW_EXIST ? ESP_OK : e;
}

static esp_err_t ensure_unicast_peer(const uint8_t *mac)
{
    if (esp_now_is_peer_exist(mac)) {
        return ESP_OK;
    }
    esp_now_peer_info_t peer = {0};
    memcpy(peer.peer_addr, mac, 6);
    peer.channel = s_channel;
    peer.ifidx = WIFI_IF_STA;
    peer.encrypt = false;
    esp_err_t e = esp_now_add_peer(&peer);
    /* The USB task (SET_NEUTRAL, PAIR) and the tx task both add peers. */
    return e == ESP_ERR_ESPNOW_EXIST ? ESP_OK : e;
}

/* Which paired slot a completion callback belongs to, or -1 if the peer is not
 * (or is no longer) paired — an unpair can land between a send and its callback. */
static int slot_for_mac(const uint8_t *mac)
{
    for (int i = 0; i < (int)MC_MAX_ROBOTS; i++) {
        if (s_paired_valid[i] && memcmp(s_paired_mac[i], mac, 6) == 0) {
            return i;
        }
    }
    return -1;
}

static void espnow_send_cb(const uint8_t *mac_addr, esp_now_send_status_t status)
{
    /* Broadcast frames are unacknowledged, so ESP-NOW always reports them as
     * successful — including when every robot on the field is powered off. Only
     * unicast outcomes say anything about reachability, so ignore broadcasts
     * entirely; counting their fake successes would mask real joystick failures. */
    if (!mac_addr || is_broadcast_mac(mac_addr)) {
        return;
    }
    taskENTER_CRITICAL(&s_tx_lock);
    int slot = slot_for_mac(mac_addr);
    if (slot >= 0) {
        s_tx_inflight_us[slot] = 0;
    }
    taskEXIT_CRITICAL(&s_tx_lock);
    if (slot < 0) {
        return;
    }
    int64_t now = esp_timer_get_time();
    if (status == ESP_NOW_SEND_SUCCESS) {
        slot_note_ok(slot, now);
    } else {
        s_slot_fail_n[slot]++;
        slot_note_fail(slot, now);
    }
    /* The radio is free for this slot; send its newest frame if one is waiting. */
    if (s_tx_task) {
        xTaskNotifyGive(s_tx_task);
    }
}

/* Drop every waiting joystick frame. Called on disable, so a frame queued while
 * enabled can never go out after the field was stood down. */
static void tx_pending_clear_all(void)
{
    taskENTER_CRITICAL(&s_tx_lock);
    for (int i = 0; i < (int)MC_MAX_ROBOTS; i++) {
        s_tx_pending_valid[i] = false;
    }
    taskEXIT_CRITICAL(&s_tx_lock);
}

static void joystick_tx_task(void *arg)
{
    (void)arg;
    for (;;) {
        /* Woken by a new frame or a completion; the timeout only exists to
         * expire a stuck in-flight stamp. */
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(10));
        for (int i = 0; i < (int)MC_MAX_ROBOTS; i++) {
            joystick_packet_t pkt = {0};
            uint8_t mac[6] = {0};
            bool go = false;
            int64_t now = esp_timer_get_time();

            taskENTER_CRITICAL(&s_tx_lock);
            if (s_tx_inflight_us[i] != 0 && now - s_tx_inflight_us[i] > MC_TX_INFLIGHT_TIMEOUT_US) {
                s_tx_inflight_us[i] = 0;
            }
            if (s_tx_pending_valid[i] && (!s_paired_valid[i] || !s_global_enabled)) {
                /* Re-checked here as well as on arrival: the enable gate must hold
                 * at the moment the frame leaves, not just when it was queued. */
                s_tx_pending_valid[i] = false;
            } else if (s_tx_pending_valid[i] && s_tx_inflight_us[i] == 0) {
                pkt = s_tx_pending[i];
                memcpy(mac, s_paired_mac[i], 6);
                s_tx_pending_valid[i] = false;
                s_tx_inflight_us[i] = now;
                go = true;
            }
            taskEXIT_CRITICAL(&s_tx_lock);
            if (!go) {
                continue;
            }

            /* These two paths fail synchronously (peer table full, radio not
             * ready, queue full), so no completion callback will ever arrive for
             * them. Free the slot and stamp the failure directly; it ages out on
             * the same hold as a real NAK. */
            esp_err_t e = ensure_unicast_peer(mac);
            if (e == ESP_OK) {
                e = esp_now_send(mac, (const uint8_t *)&pkt, sizeof(pkt));
            }
            if (e != ESP_OK) {
                taskENTER_CRITICAL(&s_tx_lock);
                s_tx_inflight_us[i] = 0;
                taskEXIT_CRITICAL(&s_tx_lock);
                slot_note_sync_fail(i, esp_timer_get_time());
            }
        }
    }
}

static void espnow_recv_cb(const esp_now_recv_info_t *info, const uint8_t *data, int len)
{
    (void)info;
    if (len < 1 || !tud_mounted()) {
        return;
    }
    switch (data[0]) {
    case MC_MSG_HEARTBEAT:
        if (len >= (int)sizeof(heartbeat_packet_t)) {
            tud_hid_report(MC_HID_RID_HEARTBEAT_IN, data, sizeof(heartbeat_packet_t));
        }
        break;
    case MC_MSG_DISCOVERY_RESP:
        if (s_discovery_active && len >= (int)sizeof(discovery_response_t)) {
            tud_hid_report(MC_HID_RID_DISCOVERY_IN, data, sizeof(discovery_response_t));
        }
        break;
    case MC_MSG_NEUTRAL_ACK:
        /* Not gated on s_discovery_active: robots announce their calibration
         * unprompted at power-up as well as in answer to a scan, and the station
         * needs those to fill its fields whichever came up first. */
        if (len >= (int)sizeof(neutral_ack_packet_t)) {
            tud_hid_report(MC_HID_RID_NEUTRAL_IN, data, sizeof(neutral_ack_packet_t));
        }
        break;
    case MC_MSG_SPEED_LIMIT_ACK:
        /* Also ungated. This ack is how the station learns a robot is NOT at the
         * limit it asked for -- a robot that rebooted back to unrestricted is
         * exactly the case worth hearing about, and it will not be mid-scan. */
        if (len >= (int)sizeof(speed_limit_ack_packet_t)) {
            tud_hid_report(MC_HID_RID_SPEED_LIMIT_IN, data, sizeof(speed_limit_ack_packet_t));
        }
        break;
    default:
        break;
    }
}

void minicore_bridge_init(uint8_t wifi_channel)
{
    s_channel = wifi_channel;
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t wcfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&wcfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(esp_wifi_set_channel(s_channel, WIFI_SECOND_CHAN_NONE));
    /* Keep the radio awake. A dozing radio misses frames and forces retries,
     * and the dongle's whole job is to be listening. */
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));

    /* Before the send callback is registered, since that callback wakes it. */
    xTaskCreate(joystick_tx_task, "mc_joy_tx", 3072, NULL, 6, &s_tx_task);

    ESP_ERROR_CHECK(esp_now_init());
    ESP_ERROR_CHECK(esp_now_register_send_cb(espnow_send_cb));
    ESP_ERROR_CHECK(esp_now_register_recv_cb(espnow_recv_cb));
    if (ensure_broadcast_peer() != ESP_OK) {
        ESP_LOGW(TAG, "broadcast peer add failed");
    }

    const esp_timer_create_args_t targs = {.callback = &discovery_timer_cb, .name = "disc"};
    ESP_ERROR_CHECK(esp_timer_create(&targs, &s_disc_timer));

    ESP_LOGI(TAG, "ESP-NOW STA channel %u", s_channel);
}

uint8_t minicore_get_channel(void)
{
    return s_channel;
}

unsigned minicore_paired_count(void)
{
    unsigned n = 0;
    for (int i = 0; i < (int)MC_MAX_ROBOTS; i++) {
        if (s_paired_valid[i]) {
            n++;
        }
    }
    return n;
}

bool minicore_global_enabled(void)
{
    return s_global_enabled;
}

/* True while a broadcast failure is recent. Broadcasts never report success, so
 * the hold is the only thing that ends it. */
static bool bcast_fault_recent(int64_t now)
{
    int64_t err_us = s_bcast_err_us;
    return err_us != 0 && (now - err_us) < MC_SEND_ERR_HOLD_US;
}

uint8_t minicore_fault_slots(void)
{
    int64_t now = esp_timer_get_time();
    uint8_t mask = 0;
    taskENTER_CRITICAL(&s_tx_lock);
    for (int i = 0; i < (int)MC_MAX_ROBOTS; i++) {
        int64_t since = s_slot_fail_since_us[i];
        /* Failing without a success for the threshold, and still failing now:
         * a slot that stopped sending (field disabled) ages out on the hold. */
        if (s_paired_valid[i] && since != 0 && now - since >= MC_SEND_FAULT_US &&
            now - s_slot_err_us[i] < MC_SEND_ERR_HOLD_US) {
            mask |= (uint8_t)(1u << i);
        }
    }
    taskEXIT_CRITICAL(&s_tx_lock);
    return mask;
}

uint8_t minicore_error_flags(void)
{
    if (bcast_fault_recent(esp_timer_get_time())) {
        return 1u;
    }
    return minicore_fault_slots() != 0 ? 1u : 0u;
}

void minicore_tx_stats(uint16_t fail_n[MC_MAX_ROBOTS], uint16_t *sync_err_n)
{
    for (int i = 0; i < (int)MC_MAX_ROBOTS; i++) {
        fail_n[i] = s_slot_fail_n[i];
    }
    *sync_err_n = s_sync_err_n;
}

void minicore_bridge_hid_output(uint8_t report_id, const uint8_t *buf, size_t len)
{
    /* Deliberately no fault reset here. This used to clear the error flag on
     * every inbound report — at joystick rate, ~60x/sec — which erased the async
     * send-failure callback's result before the status task could sample it, and
     * let an unrelated report ID (pair, unpair, discovery) clear a real fault.
     * Faults now age out in minicore_error_flags() instead. */
    switch (report_id) {
    case MC_HID_RID_JOYSTICK: {
        if (len < 1 + sizeof(joystick_packet_t)) {
            return;
        }
        uint8_t ctrl = buf[0];
        if (ctrl >= MC_MAX_ROBOTS || !s_paired_valid[ctrl]) {
            return;
        }
        /* Independent gate on the enable state: a stale or buggy driver station
         * must not be able to drive a robot through this dongle without first
         * having enabled it. */
        if (!s_global_enabled) {
            return;
        }
        /* Hand it to joystick_tx_task, replacing any frame still waiting. */
        taskENTER_CRITICAL(&s_tx_lock);
        memcpy(&s_tx_pending[ctrl], buf + 1, sizeof(joystick_packet_t));
        s_tx_pending_valid[ctrl] = true;
        taskEXIT_CRITICAL(&s_tx_lock);
        xTaskNotifyGive(s_tx_task);
        break;
    }
    case MC_HID_RID_ENABLE: {
        if (len < sizeof(enable_packet_t)) {
            return;
        }
        enable_packet_t ep;
        memcpy(&ep, buf, sizeof(ep));
        if (ep.type != MC_MSG_ENABLE) {
            ep.type = MC_MSG_ENABLE;
        }
        if (is_broadcast_mac(ep.target_mac)) {
            s_global_enabled = (ep.enabled != 0);
            if (!s_global_enabled) {
                tx_pending_clear_all();
            }
        }
        if (ensure_broadcast_peer() != ESP_OK) {
            bcast_note_sync_fail();
        }
        esp_err_t e = esp_now_send(k_broadcast_mac, (uint8_t *)&ep, sizeof(ep));
        if (e != ESP_OK) {
            bcast_note_sync_fail();
        }
        break;
    }
    case MC_HID_RID_SET_SPEED_LIMIT: {
        if (len < sizeof(uint16_t)) {
            return;
        }
        uint16_t milli;
        memcpy(&milli, buf, sizeof(milli));

        /* Forwarded exactly as received -- deliberately NOT clamped here, for
         * the same reason the neutral trim is not: a motor-output cap is a
         * behaviour policy, and compiling one into the dongle would put its
         * range behind a BOOT/RESET reflash. The robot clamps authoritatively.
         * See minicore_policy.h. */
        set_speed_limit_packet_t sl = {
            .type = MC_MSG_SET_SPEED_LIMIT,
            .limit_milli = milli,
        };

        /* Broadcast, never unicast. The cap has to reach every robot on the
         * field, including ones no slot has paired -- an unpaired robot can
         * still be enabled by the global broadcast, so it can still move.
         *
         * Not gated on s_global_enabled: lowering the limit while the field is
         * stood down is the normal way to set it, and this frame only narrows a
         * clamp. It cannot start a motor. */
        if (ensure_broadcast_peer() != ESP_OK) {
            bcast_note_sync_fail();
        }
        esp_err_t e = esp_now_send(k_broadcast_mac, (uint8_t *)&sl, sizeof(sl));
        if (e != ESP_OK) {
            bcast_note_sync_fail();
        }
        break;
    }
    case MC_HID_RID_DISCOVERY: {
        discovery_request_t dr;
        if (len >= sizeof(dr)) {
            memcpy(&dr, buf, sizeof(dr));
        } else {
            dr.type = MC_MSG_DISCOVERY_REQ;
            dr.channel = s_channel;
        }
        if (dr.type != MC_MSG_DISCOVERY_REQ) {
            dr.type = MC_MSG_DISCOVERY_REQ;
        }
        s_discovery_active = true;
        esp_timer_stop(s_disc_timer);
        ESP_ERROR_CHECK(esp_timer_start_once(s_disc_timer, (uint64_t)MC_DISCOVERY_COLLECT_MS * 1000ULL));
        if (ensure_broadcast_peer() != ESP_OK) {
            bcast_note_sync_fail();
        }
        esp_err_t e = esp_now_send(k_broadcast_mac, (uint8_t *)&dr, sizeof(dr));
        if (e != ESP_OK) {
            bcast_note_sync_fail();
        }
        break;
    }
    case MC_HID_RID_PAIR: {
        if (len < 7) {
            return;
        }
        uint8_t idx = buf[0];
        if (idx >= MC_MAX_ROBOTS) {
            return;
        }
        taskENTER_CRITICAL(&s_tx_lock);
        memcpy(s_paired_mac[idx], buf + 1, 6);
        /* Start the slot's send history clean, before it counts as paired, so a
         * newly assigned robot never inherits the previous occupant's fault --
         * or the previous occupant's waiting frame. */
        s_slot_err_us[idx] = 0;
        s_slot_ok_us[idx] = 0;
        s_slot_fail_since_us[idx] = 0;
        s_tx_pending_valid[idx] = false;
        s_tx_inflight_us[idx] = 0;
        s_paired_valid[idx] = true;
        taskEXIT_CRITICAL(&s_tx_lock);
        if (ensure_unicast_peer(s_paired_mac[idx]) != ESP_OK) {
            ESP_LOGW(TAG, "pair: add peer failed slot %u", (unsigned)idx);
        }
        ESP_LOGI(TAG, "paired slot %u", (unsigned)idx);
        break;
    }
    case MC_HID_RID_UNPAIR: {
        if (len < 1) {
            return;
        }
        uint8_t idx = buf[0];
        if (idx >= MC_MAX_ROBOTS) {
            return;
        }
        if (s_paired_valid[idx]) {
            uint8_t zero[6] = {0};
            if (memcmp(s_paired_mac[idx], zero, 6) != 0) {
                esp_err_t d = esp_now_del_peer(s_paired_mac[idx]);
                if (d != ESP_OK && d != ESP_ERR_ESPNOW_NOT_FOUND) {
                    ESP_LOGD(TAG, "del_peer: %s", esp_err_to_name(d));
                }
            }
        }
        taskENTER_CRITICAL(&s_tx_lock);
        s_paired_valid[idx] = false;
        memset(s_paired_mac[idx], 0, 6);
        s_tx_pending_valid[idx] = false;
        s_tx_inflight_us[idx] = 0;
        taskEXIT_CRITICAL(&s_tx_lock);
        break;
    }
    case MC_HID_RID_SET_NEUTRAL: {
        if (len < 1 + 2 * sizeof(uint16_t)) {
            return;
        }
        uint8_t idx = buf[0];
        if (idx >= MC_MAX_ROBOTS || !s_paired_valid[idx]) {
            return;
        }
        uint16_t left, right;
        memcpy(&left, buf + 1, sizeof(left));
        memcpy(&right, buf + 3, sizeof(right));

        /* Forwarded exactly as received -- deliberately NOT clamped here.
         *
         * The dongle is a transport: it addresses and routes frames, it does not
         * interpret them. An ESC pulse width is not a routing concern, and the
         * robot clamps authoritatively anyway -- it has to, since calibration
         * loaded from its own filesystem never passes through here at all.
         *
         * A clamp here bought nothing observable and cost a great deal: it
         * compiled an ESC-calibration policy number into firmware that can only
         * be updated by a physical BOOT/RESET dance, so widening the allowed
         * range turned into a dongle rebuild + reflash. Keep policy out of the
         * transport and that whole class of reflash disappears. */
        set_neutral_packet_t sn = {
            .type = MC_MSG_SET_NEUTRAL,
            .neutral_left_us = left,
            .neutral_right_us = right,
        };
        memcpy(sn.target_mac, s_paired_mac[idx], 6);

        /* Unicast, never broadcast: neutral trim is per-robot ESC calibration.
         * Deliberately not gated on s_global_enabled, unlike joystick reports --
         * calibrating means watching the wheels at centered sticks, which needs
         * the robot armed, and you also want to set values before arming. This
         * changes what "stopped" means; it does not drive anything. */
        if (ensure_unicast_peer(s_paired_mac[idx]) != ESP_OK) {
            slot_note_sync_fail(idx, esp_timer_get_time());
            return;
        }
        esp_err_t e = esp_now_send(s_paired_mac[idx], (uint8_t *)&sn, sizeof(sn));
        if (e != ESP_OK) {
            slot_note_sync_fail(idx, esp_timer_get_time());
        }
        ESP_LOGI(TAG, "set neutral slot %u: %u/%u us", (unsigned)idx, (unsigned)sn.neutral_left_us,
                 (unsigned)sn.neutral_right_us);
        break;
    }
    default:
        break;
    }
}
