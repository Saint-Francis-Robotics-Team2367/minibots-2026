#include "minicore_robot.h"

#include <Arduino.h>
#include <WiFi.h>
#include <esp_log.h>
#include <esp_now.h>
#include <esp_wifi.h>

#include <cstring>

#include "minicore_protocol.h"

#ifndef LEFT_MOTOR_PIN
#define LEFT_MOTOR_PIN 16
#endif
#ifndef RIGHT_MOTOR_PIN
#define RIGHT_MOTOR_PIN 17
#endif
#ifndef MINICORE_ROBOT_NAME
#define MINICORE_ROBOT_NAME "MiniBot1"
#endif
#ifndef MINICORE_WIFI_CHANNEL
#define MINICORE_WIFI_CHANNEL 6
#endif

static const char *TAG = "minicore_robot";

static uint8_t s_dongle_mac[6];
static bool s_have_dongle;
static bool s_enabled;
static uint32_t s_last_joystick_ms;
static uint32_t s_last_hb_ms;

static int16_t map_axis_to_pwm(int16_t axis_value)
{
    return (int16_t)(1500 + (int32_t)axis_value * 500 / 32767);
}

static uint32_t us_to_duty(unsigned int us)
{
    const unsigned int freq = 50;
    const unsigned int res_bits = 14;
    const uint32_t max_duty = (1u << res_bits) - 1;
    const uint32_t period_us = 1000000u / freq;
    return (uint64_t)us * max_duty / period_us;
}

static void motor_write(int pin, int pulse_us)
{
    pulse_us = constrain(pulse_us, 1000, 2000);
    ledcWrite(pin, us_to_duty((unsigned int)pulse_us));
}

static void stop_motors(void)
{
    motor_write(LEFT_MOTOR_PIN, 1500);
    motor_write(RIGHT_MOTOR_PIN, 1500);
}

static bool ensure_peer(const uint8_t *mac)
{
    if (esp_now_is_peer_exist(mac)) {
        return true;
    }
    esp_now_peer_info_t peer = {};
    memcpy(peer.peer_addr, mac, 6);
    peer.channel = MINICORE_WIFI_CHANNEL;
    peer.ifidx = WIFI_IF_STA;
    peer.encrypt = false;
    return esp_now_add_peer(&peer) == ESP_OK;
}

static void send_heartbeat(void)
{
    if (!s_have_dongle) {
        return;
    }
    heartbeat_packet_t hb = {};
    hb.type = MC_MSG_HEARTBEAT;
    const char *name = MINICORE_ROBOT_NAME;
    hb.robot_id_len = (uint8_t)strlen(name);
    if (hb.robot_id_len > MC_ROBOT_ID_MAX) {
        hb.robot_id_len = MC_ROBOT_ID_MAX;
    }
    memcpy(hb.robot_id, name, hb.robot_id_len);
    hb.robot_id[hb.robot_id_len] = '\0';
    for (size_t i = hb.robot_id_len + 1; i < MC_ROBOT_ID_MAX; i++) {
        hb.robot_id[i] = '\0';
    }
    hb.battery_pct = 0xFF;
    hb.status_flags = s_enabled ? 1u : 0u;
    ensure_peer(s_dongle_mac);
    esp_now_send(s_dongle_mac, (uint8_t *)&hb, sizeof(hb));
}

static void on_recv(const uint8_t *mac, const uint8_t *data, int len)
{
    if (!s_have_dongle) {
        memcpy(s_dongle_mac, mac, 6);
        s_have_dongle = true;
        ESP_LOGI(TAG, "Learned dongle MAC");
    }
    if (len < 1) {
        return;
    }
    switch (data[0]) {
    case MC_MSG_DISCOVERY_REQ: {
        discovery_response_t resp = {};
        resp.type = MC_MSG_DISCOVERY_RESP;
        WiFi.macAddress(resp.mac);
        const char *name = MINICORE_ROBOT_NAME;
        resp.robot_id_len = (uint8_t)strlen(name);
        if (resp.robot_id_len > MC_ROBOT_ID_MAX) {
            resp.robot_id_len = MC_ROBOT_ID_MAX;
        }
        memcpy(resp.robot_id, name, resp.robot_id_len);
        memset(resp.robot_id + resp.robot_id_len, 0, MC_ROBOT_ID_MAX - resp.robot_id_len);
        ensure_peer(mac);
        esp_now_send(mac, (uint8_t *)&resp, sizeof(resp));
        break;
    }
    case MC_MSG_ENABLE: {
        if (len < (int)sizeof(enable_packet_t)) {
            break;
        }
        enable_packet_t ep;
        memcpy(&ep, data, sizeof(ep));
        uint8_t mymac[6];
        WiFi.macAddress(mymac);
        bool all = true;
        for (int i = 0; i < 6; i++) {
            if (ep.target_mac[i] != MC_BROADCAST_MAC_BYTE) {
                all = false;
                break;
            }
        }
        if (all || memcmp(ep.target_mac, mymac, 6) == 0) {
            s_enabled = ep.enabled != 0;
        }
        break;
    }
    case MC_MSG_JOYSTICK: {
        if (len < (int)sizeof(joystick_packet_t)) {
            break;
        }
        joystick_packet_t jp;
        memcpy(&jp, data, sizeof(jp));
        if (!s_enabled) {
            break;
        }
        s_last_joystick_ms = millis();
        int32_t forward = -jp.axis_ly; // Joystick Y is negative when pushed up
        int32_t turn = jp.axis_rx;     // Joystick X is positive when pushed right
        
        int32_t left = forward + turn;
        int32_t right = forward - turn;
        
        // Constrain to typical int16 bounds
        left = constrain(left, -32767, 32767);
        right = constrain(right, -32767, 32767);
        
        motor_write(LEFT_MOTOR_PIN, map_axis_to_pwm(left));
        motor_write(RIGHT_MOTOR_PIN, map_axis_to_pwm(right));
        break;
    }
    default:
        break;
    }
}

static void espnow_recv_cb(const uint8_t *mac, const uint8_t *data, int len)
{
    on_recv(mac, data, len);
}

void minicore_robot_setup(void)
{
    Serial.begin(115200);
    ESP_LOGI(TAG, "MiniCore robot %s", MINICORE_ROBOT_NAME);

    WiFi.mode(WIFI_STA);
    WiFi.disconnect(false, true);
    WiFi.setSleep(false);
    esp_wifi_set_promiscuous(true);
    esp_wifi_set_channel(MINICORE_WIFI_CHANNEL, WIFI_SECOND_CHAN_NONE);
    esp_wifi_set_promiscuous(false);

    if (esp_now_init() != ESP_OK) {
        ESP_LOGE(TAG, "esp_now_init failed");
        return;
    }
    esp_now_register_recv_cb(espnow_recv_cb);

    const int freq = 50;
    const int res = 14;
    ledcSetup(0, freq, res);
    ledcAttachPin(LEFT_MOTOR_PIN, 0);
    ledcSetup(1, freq, res);
    ledcAttachPin(RIGHT_MOTOR_PIN, 1);
    stop_motors();

    uint8_t bcast[] = {MC_BROADCAST_MAC_BYTE, MC_BROADCAST_MAC_BYTE, MC_BROADCAST_MAC_BYTE,
                       MC_BROADCAST_MAC_BYTE, MC_BROADCAST_MAC_BYTE, MC_BROADCAST_MAC_BYTE};
    if (!esp_now_is_peer_exist(bcast)) {
        esp_now_peer_info_t p = {};
        memcpy(p.peer_addr, bcast, 6);
        p.channel = MINICORE_WIFI_CHANNEL;
        p.ifidx = WIFI_IF_STA;
        p.encrypt = false;
        esp_now_add_peer(&p);
    }

    s_last_joystick_ms = millis();
    s_last_hb_ms = millis();
}

void minicore_robot_loop(void)
{
    uint32_t now = millis();
    if (s_enabled && (now - s_last_joystick_ms) > MC_MOTOR_TIMEOUT_MS) {
        stop_motors();
    }
    if (now - s_last_hb_ms >= MC_HEARTBEAT_INTERVAL_MS) {
        s_last_hb_ms = now;
        send_heartbeat();
    }
}
