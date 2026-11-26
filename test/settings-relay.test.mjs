import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RelaySetupPanel } from '../src/settings-relay-view.mjs';

test('relay setup initially offers a local check, with no implicit remote or USB operation', () => {
  const html = renderToStaticMarkup(React.createElement(RelaySetupPanel, {
    remote: { relay() { assert.fail('must wait for a user click'); } },
    renderPort() { assert.fail('must wait until pairing has been checked'); },
  }));
  assert.match(html,/检查本机中继配置/);
  assert.match(html,/\.stackchan-relay-device\.json/);
  assert.doesNotMatch(html,/检查设备外出配置|写入设备外出配置|撤销设备外出配置/);
  assert.doesNotMatch(html,/<input/);
});
