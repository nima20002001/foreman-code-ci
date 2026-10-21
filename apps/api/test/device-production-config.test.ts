import { expect, it } from 'vitest'
import { readDeviceListenerConfig } from '../src/modules/devices/productionConfig.js'

it('keeps the device-only listener disabled unless explicitly enabled with complete separate TLS configuration', () => {
  expect(readDeviceListenerConfig({}, 3000)).toBeUndefined()
  expect(readDeviceListenerConfig({ GRAPHQL_DEVICE_LISTENER_ENABLED: '0' }, 3000)).toBeUndefined()
  expect(() => readDeviceListenerConfig({ GRAPHQL_DEVICE_LISTENER_ENABLED: 'true' }, 3000)).toThrow('0 or 1')
  const enabled = { GRAPHQL_DEVICE_LISTENER_ENABLED: '1', DEVICE_LISTENER_HOST: '0.0.0.0', DEVICE_LISTENER_PORT: '3443',
    DEVICE_LISTENER_TLS_CERT_FILE: '/approved/certificate.pem', DEVICE_LISTENER_TLS_KEY_FILE: '/approved/key.pem' }
  expect(readDeviceListenerConfig(enabled, 3000)).toEqual({ host: '0.0.0.0', port: 3443,
    certificateFile: '/approved/certificate.pem', privateKeyFile: '/approved/key.pem' })
  expect(() => readDeviceListenerConfig({ ...enabled, DEVICE_LISTENER_PORT: '3000' }, 3000)).toThrow('own explicit')
  expect(() => readDeviceListenerConfig({ ...enabled, DEVICE_LISTENER_TLS_KEY_FILE: 'relative.pem' }, 3000)).toThrow('absolute TLS')
  expect(() => readDeviceListenerConfig({ ...enabled, DEVICE_LISTENER_HOST: '' }, 3000)).toThrow('explicit bind')
})

it('retains only the explicit public WSS endpoint and approved public CA path', () => {
  const enabled = { GRAPHQL_DEVICE_LISTENER_ENABLED: '1', DEVICE_LISTENER_HOST: '0.0.0.0', DEVICE_LISTENER_PORT: '3443',
    DEVICE_LISTENER_TLS_CERT_FILE: '/approved/certificate.pem', DEVICE_LISTENER_TLS_KEY_FILE: '/approved/key.pem',
    DEVICE_LISTENER_ADVERTISED_ENDPOINT: 'wss://main.example:3443/device/connect', DEVICE_LISTENER_TLS_TRUST_CERT_FILE: '/approved/public-ca.pem' }
  expect(readDeviceListenerConfig(enabled, 3000)).toMatchObject({ advertisedEndpoint: enabled.DEVICE_LISTENER_ADVERTISED_ENDPOINT, trustCertificateFile: enabled.DEVICE_LISTENER_TLS_TRUST_CERT_FILE })
  for (const endpoint of ['ws://main.example/device/connect', 'wss://0.0.0.0/device/connect', 'wss://main.example/another', 'wss://user:secret@main.example/device/connect', 'wss://main.example/device/connect?token=secret']) {
    expect(() => readDeviceListenerConfig({ ...enabled, DEVICE_LISTENER_ADVERTISED_ENDPOINT: endpoint }, 3000)).toThrow()
  }
  expect(() => readDeviceListenerConfig({ ...enabled, DEVICE_LISTENER_TLS_TRUST_CERT_FILE: 'relative.pem' }, 3000)).toThrow('absolute approved public CA')
})
