<script setup lang="ts">
import { ref } from 'vue';
import Icon from './Icon.vue';
import { t, message } from '../i18n';
import type { JumpHost, LoginSecret } from '../types';

const props = defineProps<{
  modelValue: JumpHost[];
  secrets: Record<string, LoginSecret>;
  disabled: boolean;
  testing?: string;
  results: Record<string, { text: string; error: boolean }>;
  pickKey: () => Promise<string | null>;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: JumpHost[]];
  test: [id: string];
  cancel: [];
}>();
const collapsed = ref<Record<string, boolean>>({});
const keyError = ref('');
function add() {
  const hop: JumpHost = { id: crypto.randomUUID(), name: '', host: '', port: 22, username: '', authType: 'key', keyPath: '' };
  props.secrets[hop.id] = { remember: false };
  emit('update:modelValue', [...props.modelValue, hop]);
}
function move(index: number, direction: number) {
  const hops = [...props.modelValue];
  [hops[index], hops[index + direction]] = [hops[index + direction]!, hops[index]!];
  emit('update:modelValue', hops);
}
function remove(id: string) {
  delete props.secrets[id];
  emit('update:modelValue', props.modelValue.filter(h => h.id !== id));
}
async function chooseKey(hop: JumpHost) {
  keyError.value = '';
  try {
    const path = await props.pickKey();
    if (path) hop.keyPath = path;
  } catch (error) { keyError.value = error instanceof Error ? error.message : String(error); }
}
</script>

<template>
  <section class="jump-hosts" data-testid="jump-hosts">
    <div class="jump-toolbar"><span v-if="modelValue.length">{{ t('跳板机链路') }}</span><button type="button" class="button secondary" data-testid="add-jump-host" :disabled="disabled" @click="add"><Icon name="plus" :size="15" />{{ t('添加跳板机') }}</button></div>
    <p v-if="modelValue.length" class="jump-hint">{{ t('按从上到下的顺序连接，最后到达目标服务器。') }}</p>
    <article v-for="(hop, index) in modelValue" :key="hop.id" class="jump-card" :data-hop-id="hop.id">
      <div class="jump-heading"><button type="button" class="jump-toggle" :aria-expanded="!collapsed[hop.id]" @click="collapsed[hop.id] = !collapsed[hop.id]"><Icon :name="collapsed[hop.id] ? 'chevron' : 'down'" :size="15" /><strong>{{ t('跳板机 {n}', { n: index + 1 }) }}</strong><span>{{ hop.name || hop.host }}</span></button><div class="jump-controls"><button class="icon-button" type="button" :disabled="disabled || index === 0" :title="t('上移')" :aria-label="t('上移')" @click="move(index, -1)"><Icon name="up" :size="15" /></button><button class="icon-button" type="button" :disabled="disabled || index === modelValue.length - 1" :title="t('下移')" :aria-label="t('下移')" @click="move(index, 1)"><Icon name="up" :size="15" class="point-down" /></button><button class="icon-button danger-hover" type="button" :disabled="disabled" :title="t('删除跳板机')" :aria-label="t('删除跳板机')" @click="remove(hop.id)"><Icon name="trash" :size="15" /></button></div></div>
      <fieldset v-show="!collapsed[hop.id]" :disabled="disabled" class="jump-fields" @invalid.capture="collapsed[hop.id] = false">
        <label class="field">{{ t('名称') }}<span class="field-optional">{{ t('可选') }}</span><input v-model="hop.name" maxlength="80" /></label>
        <div class="form-row host-row"><label class="field">{{ t('服务器地址') }}<input v-model="hop.host" :placeholder="t('IP 地址或主机名')" maxlength="253" required /></label><label class="field">{{ t('端口') }}<input v-model.number="hop.port" type="number" min="1" max="65535" required /></label></div>
        <label class="field">{{ t('用户名') }}<input v-model="hop.username" maxlength="80" required autocomplete="off" /></label>
        <div class="segmented-control"><button type="button" :class="{ active: hop.authType === 'key' }" @click="hop.authType = 'key'"><Icon name="key" :size="15" />{{ t('SSH 密钥') }}</button><button type="button" :class="{ active: hop.authType === 'password' }" @click="hop.authType = 'password'"><Icon name="lock" :size="15" />{{ t('密码') }}</button></div>
        <template v-if="hop.authType === 'key'"><label class="field">{{ t('私钥文件') }}<div class="input-with-button"><input v-model="hop.keyPath" :placeholder="t('选择本机私钥文件')" required /><button type="button" class="icon-button" :aria-label="t('选择私钥文件')" @click="chooseKey(hop)"><Icon name="folder" :size="17" /></button></div></label><label class="field">{{ t('密钥口令') }}<input v-model="secrets[hop.id]!.passphrase" type="password" :placeholder="t('留空使用已有口令或未加密密钥')" autocomplete="new-password" /></label></template>
        <label v-else class="field">{{ t('连接密码') }}<input v-model="secrets[hop.id]!.password" type="password" :placeholder="hop.hasSavedSecret ? t('留空保留已有密码') : t('可稍后在连接时输入')" autocomplete="new-password" /></label>
        <label class="checkbox-row"><input v-model="secrets[hop.id]!.remember" type="checkbox" /><span>{{ t(hop.authType === 'password' ? '记住密码' : '记住密钥口令') }}<small>{{ t('使用系统加密存储；不勾选则仅在本次运行中使用。') }}</small></span></label>
      </fieldset>
      <div class="jump-test"><button v-if="testing === hop.id" type="button" class="button secondary" @click="emit('cancel')">{{ t('取消测试') }}</button><button v-else type="button" class="button secondary" :disabled="disabled" @click="emit('test', hop.id)"><Icon name="link" :size="15" />{{ t('测试连接') }}</button><span v-if="testing === hop.id" role="status">{{ t('正在测试连接…') }}</span></div>
      <p v-if="results[hop.id]" class="connection-test-result" :class="{ error: results[hop.id]!.error }" role="status">{{ message(results[hop.id]!.text) }}</p>
    </article>
    <p v-if="keyError" class="connection-test-result error" role="alert">{{ message(keyError) }}</p>
  </section>
</template>

<style scoped>
.jump-hosts { display: grid; gap: 12px; }
.jump-toolbar,.jump-heading,.jump-controls,.jump-test { display: flex; align-items: center; gap: 8px; }
.jump-toolbar { justify-content: space-between; }.jump-toolbar>span { font-weight: 600; }
.jump-hint { color: var(--text-secondary); font-size: 11px; margin: 0; line-height: 1.6; }
.jump-card { border: 1px solid var(--surface-border); border-radius: 10px; background: var(--surface-input); padding: 12px; }
.jump-heading { margin-bottom: 12px; }.jump-toggle { display: flex; align-items: center; gap: 6px; padding: 0; min-width: 0; flex: 1; border: 0; background: transparent; color: var(--text); cursor: pointer; font: inherit; text-align: left; }
.jump-toggle strong { white-space: nowrap; font-size: 12px; }.jump-toggle span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--text-secondary); }
.jump-controls { gap: 2px; }.jump-controls .icon-button { width: 26px; height: 26px; }.point-down { transform: rotate(180deg); }
.jump-fields { border: 0; padding: 0; margin: 0; min-width: 0; display: grid; gap: 14px; }.jump-test { margin-top: 12px; }.jump-test>span { color: var(--text-secondary); font-size: 11px; }
.jump-fields .field,.jump-fields .segmented-control,.jump-fields .checkbox-row { margin: 0; }
.connection-test-result { margin: 10px 0 0; font-size: 11px; color: var(--green); overflow-wrap: anywhere; }.connection-test-result.error { color: var(--red); }
</style>
