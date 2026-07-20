(() => {
  'use strict';

  const storageKeys = {
    device: 'ruscny.web.device',
    session: 'ruscny.account.session',
  };
  const allowedAvatars = new Set(['jade', 'ocean', 'amber', 'plum', 'graphite', 'rose']);
  const authForm = document.querySelector('#account-form');
  const authPanel = document.querySelector('#auth-panel');
  const emailFlowPanel = document.querySelector('#email-flow-panel');
  const sessionPanel = document.querySelector('#session-panel');
  const statusBox = document.querySelector('.form-status');
  const settingsStatus = document.querySelector('.settings-status');
  const submitButton = document.querySelector('.auth-submit');
  const passwordInput = document.querySelector('#account-password');
  const confirmPasswordInput = document.querySelector('#confirm-password');
  const logoutButton = document.querySelector('#logout-button');
  const profileForm = document.querySelector('#profile-form');
  const preferencesForm = document.querySelector('#preferences-form');
  const changePasswordForm = document.querySelector('#password-form');
  const deviceList = document.querySelector('#device-list');
  const refreshDevicesButton = document.querySelector('#refresh-devices');
  const resendVerificationForm = document.querySelector('#resend-verification-form');
  const forgotPasswordForm = document.querySelector('#forgot-password-form');
  const resetPasswordForm = document.querySelector('#reset-password-form');
  const emailFlowStatus = document.querySelector('.email-flow-status');
  let mode = 'register';
  let session = readSession();
  let refreshInFlight = null;
  let pendingEmail = '';
  let actionToken = '';
  let devicesInFlight = null;

  const messages = {
    zh: {
      loading: '正在提交…', restoring: '正在恢复当前网页账号…', registered: '注册资料已保存，激活邮件已经发送。', loggedIn: '登录成功。',
      requiredName: '请输入姓名或显示名称。', invalidEmail: '请输入有效邮箱。', invalidPassword: '密码必须为 8 至 128 位。', mismatch: '两次输入的密码不一致。', consent: '请先阅读并同意用户协议和隐私政策。',
      EMAIL_EXISTS: '该邮箱已注册，请直接登录。', EMAIL_NOT_VERIFIED: '该账号尚未激活，请先查收激活邮件。', EMAIL_VERIFICATION_REQUIRED: '该邮箱尚未激活，可以重新发送激活邮件。', EMAIL_DELIVERY_FAILED: '账号已创建，但邮件暂未送出，请稍后重新发送。', VERIFICATION_TOKEN_INVALID: '激活链接无效或已过期，请重新发送激活邮件。', RESET_TOKEN_INVALID: '密码重置链接无效或已过期，请重新申请。', INVALID_CREDENTIALS: '邮箱或密码错误。', INVALID_CURRENT_PASSWORD: '当前密码错误。', PASSWORD_UNCHANGED: '新密码不能与当前密码相同。', ACCOUNT_CHANGED: '账号状态已变化，请重新登录后再试。', DUPLICATE_RESOURCE: '该手机号已被其他账号使用。', RATE_LIMITED: '操作过于频繁，请稍后再试。', VALIDATION_ERROR: '填写内容不符合要求，请检查后重试。', ACCOUNT_DISABLED: '账号不存在或已停用。', DEVICE_REVOKED: '当前设备已下线，请重新登录。',
      SERVICE_PREPARING: '账号服务正在准备中，当前不会创建账号。正式开放后即可注册或登录。', network: '无法连接服务器，请检查网络后重试。', generic: '暂时无法完成操作，请稍后重试。', notSet: '未填写', chinese: '🇨🇳 中文', russian: '🇷🇺 Русский', loggingOut: '正在退出…',
      saving: '正在保存…', profileSaved: '个人资料已保存。', preferencesSaved: '个人偏好已保存并同步到账号。', passwordChanged: '密码已修改，其他登录设备已下线。', passwordMismatch: '两次输入的新密码不一致。', passwordSame: '新密码不能与当前密码相同。', verificationSent: '如果该邮箱对应尚未激活的账号，新的激活邮件已经发送。', verificationSuccess: '邮箱认证成功，现在可以登录。', verifying: '正在安全验证激活链接…', resetEmailSent: '如果该邮箱对应可用账号，密码重置邮件已经发送。', passwordResetSuccess: '密码已重置，请使用新密码重新登录。', invalidActionLink: '邮件链接缺少有效凭证，请重新申请。', devicesLoading: '正在读取登录设备…', devicesEmpty: '没有可显示的登录设备。', currentDevice: '当前设备', activeDevice: '已登录', revokedDevice: '已下线', browserDevice: '网页浏览器', androidDevice: 'Android 设备', iosDevice: 'iPhone / iPad', otherDevice: '其他设备', lastActive: '最近使用', revokeDevice: '立即下线', revokeDeviceConfirm: '确定让这台设备退出登录吗？', deviceRevoked: '设备已下线。', verifiedEmail: '✓ 邮箱已认证'
    },
    ru: {
      loading: 'Отправка…', restoring: 'Восстанавливаем вход…', registered: 'Данные сохранены. Письмо для активации отправлено.', loggedIn: 'Вход выполнен.',
      requiredName: 'Укажите имя или отображаемое имя.', invalidEmail: 'Введите корректный email.', invalidPassword: 'Пароль должен содержать от 8 до 128 символов.', mismatch: 'Пароли не совпадают.', consent: 'Сначала примите условия использования и политику конфиденциальности.',
      EMAIL_EXISTS: 'Этот email уже зарегистрирован. Выполните вход.', EMAIL_NOT_VERIFIED: 'Аккаунт ещё не активирован. Проверьте почту.', EMAIL_VERIFICATION_REQUIRED: 'Email ещё не подтверждён. Можно отправить письмо повторно.', EMAIL_DELIVERY_FAILED: 'Аккаунт создан, но письмо пока не отправлено. Повторите позже.', VERIFICATION_TOKEN_INVALID: 'Ссылка активации недействительна или истекла.', RESET_TOKEN_INVALID: 'Ссылка сброса пароля недействительна или истекла.', INVALID_CREDENTIALS: 'Неверный email или пароль.', INVALID_CURRENT_PASSWORD: 'Неверный текущий пароль.', PASSWORD_UNCHANGED: 'Новый пароль должен отличаться от текущего.', ACCOUNT_CHANGED: 'Состояние аккаунта изменилось. Войдите снова.', DUPLICATE_RESOURCE: 'Этот номер телефона уже используется другим аккаунтом.', RATE_LIMITED: 'Слишком много попыток. Повторите позже.', VALIDATION_ERROR: 'Проверьте заполненные данные и повторите попытку.', ACCOUNT_DISABLED: 'Аккаунт не найден или отключён.', DEVICE_REVOKED: 'Это устройство отключено. Войдите снова.',
      SERVICE_PREPARING: 'Сервис аккаунтов пока готовится. Сейчас аккаунт не будет создан. Регистрация и вход откроются после запуска.', network: 'Не удалось подключиться к серверу. Проверьте сеть.', generic: 'Не удалось выполнить операцию. Повторите позже.', notSet: 'Не указано', chinese: '🇨🇳 中文', russian: '🇷🇺 Русский', loggingOut: 'Выход…',
      saving: 'Сохранение…', profileSaved: 'Профиль сохранён.', preferencesSaved: 'Предпочтения сохранены и синхронизированы с аккаунтом.', passwordChanged: 'Пароль изменён. Другие устройства отключены.', passwordMismatch: 'Новые пароли не совпадают.', passwordSame: 'Новый пароль должен отличаться от текущего.', verificationSent: 'Если аккаунт ожидает активации, новое письмо уже отправлено.', verificationSuccess: 'Email подтверждён. Теперь можно войти.', verifying: 'Безопасно проверяем ссылку активации…', resetEmailSent: 'Если аккаунт доступен, письмо для сброса пароля уже отправлено.', passwordResetSuccess: 'Пароль изменён. Войдите с новым паролем.', invalidActionLink: 'В ссылке нет действующего токена. Запросите новое письмо.', devicesLoading: 'Загружаем устройства…', devicesEmpty: 'Нет устройств для отображения.', currentDevice: 'Текущее устройство', activeDevice: 'Выполнен вход', revokedDevice: 'Отключено', browserDevice: 'Веб-браузер', androidDevice: 'Устройство Android', iosDevice: 'iPhone / iPad', otherDevice: 'Другое устройство', lastActive: 'Последняя активность', revokeDevice: 'Отключить', revokeDeviceConfirm: 'Выйти из аккаунта на этом устройстве?', deviceRevoked: 'Устройство отключено.', verifiedEmail: '✓ Email подтверждён'
    }
  };

  function currentMessages() {
    return messages[document.documentElement.lang === 'ru' ? 'ru' : 'zh'];
  }

  function storageGet(storage, key) {
    try { return storage.getItem(key); } catch (_) { return null; }
  }

  function storageSet(storage, key, value) {
    try { storage.setItem(key, value); return true; } catch (_) { return false; }
  }

  function storageRemove(storage, key) {
    try { storage.removeItem(key); } catch (_) { /* Storage is optional. */ }
  }

  function readSession() {
    const raw = storageGet(sessionStorage, storageKeys.session);
    if (!raw || raw.length > 30_000) return null;
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value.accessToken !== 'string' || typeof value.refreshToken !== 'string' || typeof value.deviceId !== 'string') return null;
      return value;
    } catch (_) {
      return null;
    }
  }

  function storeSession(value) {
    session = value;
    storageSet(sessionStorage, storageKeys.session, JSON.stringify(value));
  }

  function clearSession() {
    session = null;
    storageRemove(sessionStorage, storageKeys.session);
  }

  function deviceId() {
    const stored = storageGet(localStorage, storageKeys.device);
    if (stored && stored.length >= 8 && stored.length <= 200) return stored;
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    const value = `web-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    storageSet(localStorage, storageKeys.device, value);
    return value;
  }

  function showStatus(message, error = false) {
    statusBox.textContent = message;
    statusBox.classList.toggle('error', error);
    statusBox.hidden = !message;
  }

  function showSettingsStatus(message, error = false) {
    settingsStatus.textContent = message;
    settingsStatus.classList.toggle('error', error);
    settingsStatus.hidden = !message;
  }

  function showEmailFlowStatus(message, error = false) {
    emailFlowStatus.textContent = message;
    emailFlowStatus.classList.toggle('error', error);
    emailFlowStatus.hidden = !message;
  }

  function setBusy(busy, message = '') {
    submitButton.disabled = busy;
    document.querySelectorAll('[data-auth-mode], [data-switch-mode]').forEach((button) => { button.disabled = busy; });
    if (message) showStatus(message);
  }

  function setFormBusy(form, busy) {
    form.querySelectorAll('button, input, select').forEach((control) => { control.disabled = busy; });
    const button = form.querySelector('.settings-submit');
    if (button) button.setAttribute('aria-busy', String(busy));
  }

  function apiError(code) {
    const dictionary = currentMessages();
    return dictionary[code] || dictionary.generic;
  }

  async function apiRequest(path, options = {}) {
    let response;
    try {
      response = await fetch(path, {
        method: options.method || 'GET',
        headers: {
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (_) {
      const error = new Error(currentMessages().network);
      error.code = 'NETWORK_ERROR';
      throw error;
    }
    let payload = null;
    try { payload = await response.json(); } catch (_) { /* A stable fallback is shown below. */ }
    if (!response.ok || !payload?.ok) {
      const code = payload?.code || ([404, 500, 502, 503].includes(response.status) ? 'SERVICE_PREPARING' : 'REQUEST_FAILED');
      const error = new Error(apiError(code));
      error.code = code;
      error.status = response.status;
      throw error;
    }
    return payload.data;
  }

  async function refreshSession() {
    if (refreshInFlight) return refreshInFlight;
    if (!session?.refreshToken || !session?.deviceId) throw new Error(currentMessages().generic);
    refreshInFlight = apiRequest('/v1/auth/refresh', {
      method: 'POST',
      body: { refreshToken: session.refreshToken, deviceId: session.deviceId },
    }).then((data) => {
      const next = { accessToken: data.accessToken, refreshToken: data.refreshToken, deviceId: session.deviceId, user: data.user };
      storeSession(next);
      return next;
    }).finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  }

  async function authenticatedRequest(path, options = {}) {
    try {
      return await apiRequest(path, { ...options, accessToken: session.accessToken });
    } catch (error) {
      if (error.status !== 401 || error.code !== 'TOKEN_INVALID') throw error;
      const refreshed = await refreshSession();
      return apiRequest(path, { ...options, accessToken: refreshed.accessToken });
    }
  }

  function setMode(nextMode, updateUrl = true) {
    mode = nextMode === 'login' ? 'login' : 'register';
    authPanel.hidden = false;
    emailFlowPanel.hidden = true;
    document.querySelectorAll('[data-mode-section]').forEach((element) => {
      element.hidden = element.dataset.modeSection !== mode;
    });
    document.querySelectorAll('[data-auth-mode]').forEach((button) => {
      const selected = button.dataset.authMode === mode;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    document.querySelector('#display-name').required = mode === 'register';
    confirmPasswordInput.required = mode === 'register';
    document.querySelector('#account-consent').required = mode === 'register';
    passwordInput.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    showStatus('');
    if (updateUrl) {
      const url = new URL(globalThis.location.href);
      url.searchParams.set('mode', mode);
      globalThis.history.replaceState(null, '', `${url.pathname}?${url.searchParams.toString()}`);
    }
  }

  function showEmailFlow(flow, message = '', error = false) {
    const selected = ['verification-pending', 'forgot', 'verify', 'reset'].includes(flow) ? flow : 'forgot';
    authPanel.hidden = true;
    sessionPanel.hidden = true;
    emailFlowPanel.hidden = false;
    document.querySelectorAll('[data-email-flow]').forEach((panel) => {
      panel.hidden = panel.dataset.emailFlow !== selected;
    });
    if (pendingEmail) {
      const field = emailFlowPanel.querySelector(`[data-email-flow="${selected}"] [name="email"]`);
      if (field) field.value = pendingEmail;
    }
    showEmailFlowStatus(message, error);
    const url = new URL(globalThis.location.href);
    url.searchParams.set('mode', selected === 'verification-pending' ? 'pending' : selected);
    globalThis.history.replaceState(null, '', `${url.pathname}?${url.searchParams.toString()}`);
  }

  function formValue(form, name, trim = true) {
    const value = new FormData(form).get(name)?.toString() || '';
    return trim ? value.trim() : value;
  }

  function validateAuthForm() {
    const dictionary = currentMessages();
    const email = formValue(authForm, 'email');
    const password = formValue(authForm, 'password', false);
    if (mode === 'register' && !formValue(authForm, 'displayName')) return dictionary.requiredName;
    if (!email || !document.querySelector('#account-email').validity.valid) return dictionary.invalidEmail;
    if (password.length < 8 || password.length > 128) return dictionary.invalidPassword;
    if (mode === 'register' && password !== formValue(authForm, 'confirmPassword', false)) return dictionary.mismatch;
    if (mode === 'register' && !document.querySelector('#account-consent').checked) return dictionary.consent;
    return '';
  }

  function normalizedAvatar(value) {
    return allowedAvatars.has(value) ? value : 'jade';
  }

  function avatarInitial(user) {
    const text = user?.displayName?.trim();
    return text ? Array.from(text)[0].toUpperCase() : (document.documentElement.lang === 'ru' ? 'Я' : '用');
  }

  function populateSettings(user) {
    profileForm.elements.displayName.value = user?.displayName || '';
    profileForm.elements.company.value = user?.company || '';
    profileForm.elements.phone.value = user?.phone || '';
    const language = user?.preferredLanguage === 'ru' ? 'ru' : 'zh';
    const languageRadio = profileForm.querySelector(`[name="preferredLanguage"][value="${language}"]`);
    if (languageRadio) languageRadio.checked = true;
    const preset = normalizedAvatar(user?.avatarPreset);
    const avatarRadio = profileForm.querySelector(`[name="avatarPreset"][value="${preset}"]`);
    if (avatarRadio) avatarRadio.checked = true;
    preferencesForm.elements.interfaceLanguage.value = ['zh', 'ru'].includes(user?.interfaceLanguage) ? user.interfaceLanguage : 'system';
    preferencesForm.elements.autoPlayTranslationAudio.checked = user?.autoPlayTranslationAudio !== false;
    const speed = [0.75, 1, 1.25, 1.5].includes(Number(user?.translationPlaybackSpeed)) ? String(user.translationPlaybackSpeed) : '1';
    preferencesForm.elements.translationPlaybackSpeed.value = speed;
  }

  function renderProfile(user, { populate = true } = {}) {
    document.querySelectorAll('[data-profile="displayName"]').forEach((element) => { element.textContent = user?.displayName || currentMessages().notSet; });
    document.querySelectorAll('[data-profile="email"]').forEach((element) => { element.textContent = user?.email || currentMessages().notSet; });
    const avatar = document.querySelector('[data-avatar-preview]');
    const preset = normalizedAvatar(user?.avatarPreset);
    avatar.className = `account-avatar avatar-${preset}`;
    avatar.textContent = avatarInitial(user);
    const emailStatus = document.querySelector('[data-email-status]');
    emailStatus.textContent = currentMessages().verifiedEmail;
    emailStatus.hidden = !user?.emailVerifiedAt;
    if (populate) populateSettings(user);
    authPanel.hidden = true;
    sessionPanel.hidden = false;
  }

  function updateSessionUser(user) {
    storeSession({ ...session, user });
    renderProfile(user);
  }

  function setSettingsTab(tabName) {
    const selectedTab = ['profile', 'preferences', 'security'].includes(tabName) ? tabName : 'profile';
    document.querySelectorAll('[data-settings-tab]').forEach((button) => {
      const selected = button.dataset.settingsTab === selectedTab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll('[data-settings-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.settingsPanel !== selectedTab;
    });
    showSettingsStatus('');
    if (selectedTab === 'security') void loadDevices();
  }

  function deviceLabel(device) {
    const dictionary = currentMessages();
    if (device?.platform === 'UNKNOWN') return dictionary.browserDevice;
    if (device?.platform === 'ANDROID') return dictionary.androidDevice;
    if (device?.platform === 'IOS') return dictionary.iosDevice;
    return dictionary.otherDevice;
  }

  function deviceTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat(document.documentElement.lang === 'ru' ? 'ru-RU' : 'zh-CN', {
      dateStyle: 'medium', timeStyle: 'short',
    }).format(date);
  }

  function renderDevices(devices) {
    deviceList.replaceChildren();
    const dictionary = currentMessages();
    if (!Array.isArray(devices) || devices.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'device-empty';
      empty.textContent = dictionary.devicesEmpty;
      deviceList.append(empty);
      return;
    }
    devices.forEach((device) => {
      const item = document.createElement('li');
      item.className = 'device-item';
      const icon = document.createElement('span');
      icon.className = 'device-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = device.platform === 'ANDROID' ? 'A' : device.platform === 'IOS' ? 'i' : 'W';
      const details = document.createElement('div');
      const name = document.createElement('b');
      name.textContent = deviceLabel(device);
      const meta = document.createElement('small');
      const deviceState = device.isCurrent ? dictionary.currentDevice : device.revokedAt ? dictionary.revokedDevice : dictionary.activeDevice;
      meta.textContent = `${deviceState} · ${dictionary.lastActive} ${deviceTime(device.lastSeenAt)}`;
      details.append(name, meta);
      item.append(icon, details);
      if (!device.isCurrent && !device.revokedAt) {
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.className = 'device-revoke';
        revoke.textContent = dictionary.revokeDevice;
        revoke.addEventListener('click', () => void revokeDevice(device.deviceId));
        item.append(revoke);
      } else {
        const badge = document.createElement('span');
        badge.className = `device-state${device.revokedAt ? ' revoked' : ''}`;
        badge.textContent = deviceState;
        item.append(badge);
      }
      deviceList.append(item);
    });
  }

  async function loadDevices() {
    if (devicesInFlight) return devicesInFlight;
    refreshDevicesButton.disabled = true;
    deviceList.setAttribute('aria-busy', 'true');
    const loading = document.createElement('li');
    loading.className = 'device-empty';
    loading.textContent = currentMessages().devicesLoading;
    deviceList.replaceChildren(loading);
    devicesInFlight = authenticatedRequest('/v1/auth/devices')
      .then(renderDevices)
      .catch((error) => {
        deviceList.replaceChildren();
        showSettingsStatus(error.message || currentMessages().generic, true);
      })
      .finally(() => {
        devicesInFlight = null;
        refreshDevicesButton.disabled = false;
        deviceList.removeAttribute('aria-busy');
      });
    return devicesInFlight;
  }

  async function revokeDevice(targetDeviceId) {
    if (!globalThis.confirm(currentMessages().revokeDeviceConfirm)) return;
    try {
      await authenticatedRequest(`/v1/auth/devices/${encodeURIComponent(targetDeviceId)}`, { method: 'DELETE' });
      showSettingsStatus(currentMessages().deviceRevoked);
      await loadDevices();
    } catch (error) {
      showSettingsStatus(error.message || currentMessages().generic, true);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const validationError = validateAuthForm();
    if (validationError) {
      showStatus(validationError, true);
      return;
    }
    setBusy(true, currentMessages().loading);
    const registration = mode === 'register';
    const body = {
      email: formValue(authForm, 'email').toLowerCase(),
      password: formValue(authForm, 'password', false),
      deviceId: deviceId(),
      platform: 'UNKNOWN',
      ...(registration ? {
        displayName: formValue(authForm, 'displayName'),
        ...(formValue(authForm, 'company') ? { company: formValue(authForm, 'company') } : {}),
        preferredLanguage: formValue(authForm, 'preferredLanguage'),
      } : {}),
    };
    try {
      const data = await apiRequest(registration ? '/v1/auth/register' : '/v1/auth/login', { method: 'POST', body });
      if (registration) {
        pendingEmail = body.email;
        authForm.reset();
        showEmailFlow('verification-pending', currentMessages().registered);
      } else {
        storeSession({ accessToken: data.accessToken, refreshToken: data.refreshToken, deviceId: body.deviceId, user: data.user });
        authForm.reset();
        renderProfile(data.user);
        showSettingsStatus(currentMessages().loggedIn);
      }
    } catch (error) {
      if (['EMAIL_NOT_VERIFIED', 'EMAIL_VERIFICATION_REQUIRED', 'EMAIL_DELIVERY_FAILED'].includes(error.code)) {
        pendingEmail = body.email;
        showEmailFlow('verification-pending', error.message || currentMessages().generic, error.code === 'EMAIL_DELIVERY_FAILED');
      } else {
        showStatus(error.message || currentMessages().generic, true);
      }
    } finally {
      setBusy(false);
    }
  }

  async function resendVerification(event) {
    event.preventDefault();
    const email = formValue(resendVerificationForm, 'email').toLowerCase();
    if (!email || !resendVerificationForm.elements.email.validity.valid) {
      showEmailFlowStatus(currentMessages().invalidEmail, true);
      return;
    }
    setFormBusy(resendVerificationForm, true);
    showEmailFlowStatus(currentMessages().loading);
    try {
      await apiRequest('/v1/auth/email/resend', { method: 'POST', body: { email } });
      pendingEmail = email;
      showEmailFlowStatus(currentMessages().verificationSent);
    } catch (error) {
      showEmailFlowStatus(error.message || currentMessages().generic, true);
    } finally {
      setFormBusy(resendVerificationForm, false);
    }
  }

  async function requestPasswordReset(event) {
    event.preventDefault();
    const email = formValue(forgotPasswordForm, 'email').toLowerCase();
    if (!email || !forgotPasswordForm.elements.email.validity.valid) {
      showEmailFlowStatus(currentMessages().invalidEmail, true);
      return;
    }
    setFormBusy(forgotPasswordForm, true);
    showEmailFlowStatus(currentMessages().loading);
    try {
      await apiRequest('/v1/auth/password/forgot', { method: 'POST', body: { email } });
      pendingEmail = email;
      showEmailFlowStatus(currentMessages().resetEmailSent);
    } catch (error) {
      showEmailFlowStatus(error.message || currentMessages().generic, true);
    } finally {
      setFormBusy(forgotPasswordForm, false);
    }
  }

  async function verifyEmail() {
    showEmailFlow('verify', currentMessages().verifying);
    if (!actionToken) {
      showEmailFlowStatus(currentMessages().invalidActionLink, true);
      return;
    }
    try {
      await apiRequest('/v1/auth/email/verify', { method: 'POST', body: { token: actionToken } });
      actionToken = '';
      showEmailFlowStatus(currentMessages().verificationSuccess);
    } catch (error) {
      showEmailFlowStatus(error.message || currentMessages().generic, true);
    }
  }

  async function resetPasswordByEmail(event) {
    event.preventDefault();
    const newPassword = formValue(resetPasswordForm, 'newPassword', false);
    const confirmation = formValue(resetPasswordForm, 'confirmNewPassword', false);
    if (!actionToken) {
      showEmailFlowStatus(currentMessages().invalidActionLink, true);
      return;
    }
    if (newPassword.length < 8 || newPassword.length > 128) {
      showEmailFlowStatus(currentMessages().invalidPassword, true);
      return;
    }
    if (newPassword !== confirmation) {
      showEmailFlowStatus(currentMessages().passwordMismatch, true);
      return;
    }
    setFormBusy(resetPasswordForm, true);
    showEmailFlowStatus(currentMessages().saving);
    try {
      await apiRequest('/v1/auth/password/reset/email', {
        method: 'POST',
        body: { token: actionToken, newPassword },
      });
      actionToken = '';
      resetPasswordForm.reset();
      resetPasswordForm.hidden = true;
      showEmailFlowStatus(currentMessages().passwordResetSuccess);
    } catch (error) {
      showEmailFlowStatus(error.message || currentMessages().generic, true);
    } finally {
      setFormBusy(resetPasswordForm, false);
    }
  }

  async function saveProfile(event) {
    event.preventDefault();
    const displayName = formValue(profileForm, 'displayName');
    if (!displayName) {
      showSettingsStatus(currentMessages().requiredName, true);
      return;
    }
    setFormBusy(profileForm, true);
    showSettingsStatus(currentMessages().saving);
    try {
      const user = await authenticatedRequest('/v1/auth/profile', {
        method: 'PATCH',
        body: {
          displayName,
          company: formValue(profileForm, 'company') || null,
          phone: formValue(profileForm, 'phone') || null,
          preferredLanguage: formValue(profileForm, 'preferredLanguage'),
          avatarPreset: formValue(profileForm, 'avatarPreset'),
        },
      });
      updateSessionUser(user);
      showSettingsStatus(currentMessages().profileSaved);
    } catch (error) {
      showSettingsStatus(error.message || currentMessages().generic, true);
    } finally {
      setFormBusy(profileForm, false);
    }
  }

  async function savePreferences(event) {
    event.preventDefault();
    setFormBusy(preferencesForm, true);
    showSettingsStatus(currentMessages().saving);
    try {
      const user = await authenticatedRequest('/v1/auth/profile', {
        method: 'PATCH',
        body: {
          interfaceLanguage: formValue(preferencesForm, 'interfaceLanguage'),
          autoPlayTranslationAudio: preferencesForm.elements.autoPlayTranslationAudio.checked,
          translationPlaybackSpeed: Number(formValue(preferencesForm, 'translationPlaybackSpeed')),
        },
      });
      updateSessionUser(user);
      showSettingsStatus(currentMessages().preferencesSaved);
      if (['zh', 'ru'].includes(user.interfaceLanguage)) {
        const localeSelect = document.querySelector('.locale-select');
        if (localeSelect.value !== user.interfaceLanguage) {
          localeSelect.value = user.interfaceLanguage;
          localeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    } catch (error) {
      showSettingsStatus(error.message || currentMessages().generic, true);
    } finally {
      setFormBusy(preferencesForm, false);
    }
  }

  async function changePassword(event) {
    event.preventDefault();
    const currentPassword = formValue(changePasswordForm, 'currentPassword', false);
    const newPassword = formValue(changePasswordForm, 'newPassword', false);
    const confirmation = formValue(changePasswordForm, 'confirmNewPassword', false);
    if (newPassword.length < 8 || newPassword.length > 128) {
      showSettingsStatus(currentMessages().invalidPassword, true);
      return;
    }
    if (newPassword !== confirmation) {
      showSettingsStatus(currentMessages().passwordMismatch, true);
      return;
    }
    if (newPassword === currentPassword) {
      showSettingsStatus(currentMessages().passwordSame, true);
      return;
    }
    setFormBusy(changePasswordForm, true);
    showSettingsStatus(currentMessages().saving);
    try {
      await authenticatedRequest('/v1/auth/password/change', {
        method: 'POST',
        body: { currentPassword, newPassword },
      });
      changePasswordForm.reset();
      showSettingsStatus(currentMessages().passwordChanged);
    } catch (error) {
      showSettingsStatus(error.message || currentMessages().generic, true);
    } finally {
      setFormBusy(changePasswordForm, false);
    }
  }

  async function restore() {
    if (!session) return;
    authPanel.hidden = false;
    showStatus(currentMessages().restoring);
    try {
      const user = await authenticatedRequest('/v1/auth/me');
      updateSessionUser(user);
      showStatus('');
    } catch (_) {
      clearSession();
      sessionPanel.hidden = true;
      authPanel.hidden = false;
      showStatus('');
    }
  }

  async function logout() {
    const activeSession = session;
    const originalLabel = logoutButton.textContent;
    logoutButton.disabled = true;
    logoutButton.textContent = currentMessages().loggingOut;
    try {
      if (activeSession) {
        await apiRequest('/v1/auth/logout', {
          method: 'POST',
          accessToken: activeSession.accessToken,
          body: { refreshToken: activeSession.refreshToken },
        });
      }
    } catch (_) {
      // Local sign-out still wins when the network is unavailable.
    } finally {
      clearSession();
      sessionPanel.hidden = true;
      authPanel.hidden = false;
      logoutButton.disabled = false;
      logoutButton.textContent = originalLabel;
      setMode('login');
    }
  }

  document.querySelectorAll('[data-auth-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.authMode)));
  document.querySelectorAll('[data-switch-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.switchMode)));
  document.querySelectorAll('[data-email-flow-open]').forEach((button) => button.addEventListener('click', () => showEmailFlow(button.dataset.emailFlowOpen)));
  document.querySelectorAll('[data-settings-tab]').forEach((button) => button.addEventListener('click', () => setSettingsTab(button.dataset.settingsTab)));
  document.querySelectorAll('[name="avatarPreset"]').forEach((input) => input.addEventListener('change', () => {
    const avatar = document.querySelector('[data-avatar-preview]');
    avatar.className = `account-avatar avatar-${normalizedAvatar(input.value)}`;
  }));
  document.querySelectorAll('.locale-select').forEach((select) => select.addEventListener('change', () => {
    showStatus('');
    if (!sessionPanel.hidden && session?.user) renderProfile(session.user, { populate: false });
  }));
  authForm.addEventListener('submit', handleSubmit);
  resendVerificationForm.addEventListener('submit', resendVerification);
  forgotPasswordForm.addEventListener('submit', requestPasswordReset);
  resetPasswordForm.addEventListener('submit', resetPasswordByEmail);
  profileForm.addEventListener('submit', saveProfile);
  preferencesForm.addEventListener('submit', savePreferences);
  changePasswordForm.addEventListener('submit', changePassword);
  refreshDevicesButton.addEventListener('click', () => void loadDevices());
  logoutButton.addEventListener('click', logout);

  const requestedUrl = new URL(globalThis.location.href);
  const requestedMode = requestedUrl.searchParams.get('mode');
  const fragment = new URLSearchParams(requestedUrl.hash.replace(/^#/, ''));
  actionToken = fragment.get('token') || '';
  if (requestedMode === 'verify' || requestedMode === 'reset') {
    globalThis.history.replaceState(null, '', `${requestedUrl.pathname}?mode=${requestedMode}`);
    if (requestedMode === 'verify') void verifyEmail();
    else showEmailFlow('reset', actionToken ? '' : currentMessages().invalidActionLink, !actionToken);
  } else if (requestedMode === 'forgot') {
    showEmailFlow('forgot');
  } else if (requestedMode === 'pending') {
    showEmailFlow('verification-pending');
  } else {
    setMode(globalThis.location.pathname === '/login' || requestedMode === 'login' ? 'login' : 'register');
    restore();
  }
  setSettingsTab('profile');
})();
