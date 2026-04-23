/**
 * Wi-Fi channel lock + ESP-NOW bridge between WebHID (TinyUSB) and robots.
 * Protocol: firmware/common/minicore_protocol.h (MINICORE_CLAUDE.md).
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

static uint8_t s_channel = 6;
static bool s_global_enabled;
static volatile uint8_t s_error_flags;
static uint8_t s_paired_mac[MC_MAX_ROBOTS][6];
static bool s_paired_valid[MC_MAX_ROBOTS];
static bool s_discovery_active;
static esp_timer_handle_t s_disc_timer;

static void discovery_timer_cb(void *arg)
{
    (void)arg;
    s_discovery_active = false;
    ESP_LOGI(TAG, "discovery window end");
}

static esp_err_t ensure_broadcast_peer(void)
{
    uint8_t bcast[6] = {MC_BROADCAST_MAC_BYTE, MC_BROADCAST_MAC_BYTE, MC_BROADCAST_MAC_BYTE,
                        MC_BROADCAST_MAC_BYTE, MC_BROADCAST_MAC_BYTE, MC_BROADCAST_MAC_BYTE};
    if (esp_now_is_peer_exist(bcast)) {
        return ESP_OK;
    }
    esp_now_peer_info_t p = {0};
    memcpy(p.peer_addr, bcast, 6);
    p.channel = s_channel;
    p.ifidx = WIFI_IF_STA;
    p.encrypt = false;
    return esp_now_add_peer(&p);
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
    return esp_now_add_peer(&peer);
}

static void espnow_send_cb(const uint8_t *mac_addr, esp_now_send_status_t status)
{
    (void)mac_addr;
    if (status != ESP_NOW_SEND_SUCCESS) {
        s_error_flags |= 1u;
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

uint8_t minicore_error_flags(void)
{
    return s_error_flags;
}

void minicore_bridge_hid_output(uint8_t report_id, const uint8_t *buf, size_t len)
{
    s_error_flags = 0;

    switch (report_id) {
    case MC_HID_RID_JOYSTICK: {
        if (len < 1 + sizeof(joystick_packet_t)) {
            return;
        }
        uint8_t ctrl = buf[0];
        if (ctrl >= MC_MAX_ROBOTS || !s_paired_valid[ctrl]) {
            return;
        }
        if (ensure_unicast_peer(s_paired_mac[ctrl]) != ESP_OK) {
            s_error_flags |= 1u;
            return;
        }
        esp_err_t e = esp_now_send(s_paired_mac[ctrl], buf + 1, sizeof(joystick_packet_t));
        if (e != ESP_OK) {
            s_error_flags |= 1u;
        }
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
        uint8_t all[6] = {MC_BROADCAST_MAC_BYTE, MC_BROADCAST_MAC_BYTE, MC_BROADCAST_MAC_BYTE,
                          MC_BROADCAST_MAC_BYTE, MC_BROADCAST_MAC_BYTE, MC_BROADCAST_MAC_BYTE};
        bool global = (memcmp(ep.target_mac, all, 6) == 0);
        if (global) {
            s_global_enabled = (ep.enabled != 0);
        }
        if (ensure_broadcast_peer() != ESP_OK) {
            s_error_flags |= 1u;
        }
        esp_err_t e = esp_now_send(all, (uint8_t *)&ep, sizeof(ep));
        if (e != ESP_OK) {
            s_error_flags |= 1u;
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
            s_error_flags |= 1u;
        }
        uint8_t all[6] = {MC_BROADCAST_MAC_BYTE, MC_BROADCAST_MAC_BYTE, MC_BROADCAST_MAC_BYTE,
                          MC_BROADCAST_MAC_BYTE, MC_BROADCAST_MAC_BYTE, MC_BROADCAST_MAC_BYTE};
        esp_err_t e = esp_now_send(all, (uint8_t *)&dr, sizeof(dr));
        if (e != ESP_OK) {
            s_error_flags |= 1u;
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
        memcpy(s_paired_mac[idx], buf + 1, 6);
        s_paired_valid[idx] = true;
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
        s_paired_valid[idx] = false;
        memset(s_paired_mac[idx], 0, 6);
        break;
    }
    default:
        break;
    }
}
