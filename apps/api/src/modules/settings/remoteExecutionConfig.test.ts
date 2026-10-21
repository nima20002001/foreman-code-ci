import { describe, expect, it } from 'vitest'
import { DEFAULT_REMOTE_EXECUTION_SETTINGS, RemoteExecutionSettingsSchema } from '@foreman-code/contracts/management'
import { remoteExecutionListenerConfig, resolveRemoteExecutionSettings } from './remoteExecutionConfig.js'

const saved = {
  enabled: true,
  listener: {
    enabled: true, host: '127.0.0.1', port: 3443, certificateFile: '/main/cert.pem',
    privateKeyFile: '/main/key.pem', advertisedEndpoint: 'wss://main.example:3443/device/connect',
    trustCertificateFile: '/main/ca.pem',
  },
}

describe('remote execution settings', () => {
  it('uses saved values when environment overrides are absent', () => {
    expect(resolveRemoteExecutionSettings(saved, {})).toEqual({ effective: saved, environmentOverrides: [] })
    expect(remoteExecutionListenerConfig(saved, 3000)).toEqual({
      host: saved.listener.host, port: 3443, certificateFile: '/main/cert.pem', privateKeyFile: '/main/key.pem',
      advertisedEndpoint: saved.listener.advertisedEndpoint, trustCertificateFile: '/main/ca.pem',
    })
    expect(remoteExecutionListenerConfig(DEFAULT_REMOTE_EXECUTION_SETTINGS, 3000)).toBeUndefined()
  })

  it('reports every explicit override and keeps the saved values intact', () => {
    const environment = {
      FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED: '0', FOREMAN_CODE_DEVICE_LISTENER_ENABLED: '0',
      DEVICE_LISTENER_HOST: '0.0.0.0', DEVICE_LISTENER_PORT: '8443', DEVICE_LISTENER_TLS_CERT_FILE: '/override/cert.pem',
      DEVICE_LISTENER_TLS_KEY_FILE: '/override/key.pem', DEVICE_LISTENER_TLS_TRUST_CERT_FILE: '/override/ca.pem',
      DEVICE_LISTENER_ADVERTISED_ENDPOINT: 'wss://override.example:8443/device/connect',
    }
    const result = resolveRemoteExecutionSettings(saved, environment)
    expect(result.environmentOverrides).toEqual(expect.arrayContaining(Object.keys(environment)))
    expect(result.environmentOverrides).toHaveLength(8)
    expect(result.effective).toEqual({ enabled: false, listener: {
      enabled: false, host: '0.0.0.0', port: 8443, certificateFile: '/override/cert.pem', privateKeyFile: '/override/key.pem',
      advertisedEndpoint: environment.DEVICE_LISTENER_ADVERTISED_ENDPOINT, trustCertificateFile: '/override/ca.pem',
    } })
    expect(saved.listener.port).toBe(3443)
  })

  it('recognizes product environment aliases as explicit overrides', () => {
    expect(resolveRemoteExecutionSettings(saved, { GRAPHQL_LAPTOP_EXECUTION_ENABLED: '0' }))
      .toMatchObject({ effective: { enabled: false }, environmentOverrides: ['FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED'] })
    expect(() => resolveRemoteExecutionSettings(saved, { FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED: 'true' })).toThrow()
  })

  it('requires a separate listener port and rejects unsafe URLs and paths', () => {
    expect(() => remoteExecutionListenerConfig(saved, 3443)).toThrow('own explicit')
    for (const url of ['ws://main/device/connect', 'wss://0.0.0.0/device/connect',
      'wss://main/other', 'wss://user:secret@main/device/connect', 'wss://main/device/connect?token=secret']) {
      expect(RemoteExecutionSettingsSchema.safeParse({ ...saved, listener: { ...saved.listener, advertisedEndpoint: url } }).success)
        .toBe(false)
    }
    expect(RemoteExecutionSettingsSchema.safeParse({ ...saved, listener: { ...saved.listener, privateKeyFile: 'relative.pem' } }).success)
      .toBe(false)
    expect(RemoteExecutionSettingsSchema.safeParse({ ...saved, listener: { ...saved.listener, host: null } }).success).toBe(false)
  })
})
