const translations = {
  zh: {
    loginTitle: '服务器管理后台', loginHint: '请使用已授权的正式账号登录。管理员权限由服务器校验。',
    email: '邮箱', password: '密码', signIn: '登录管理后台', language: '语言', overview: '概览', users: '用户管理',
    meetings: '会议管理', failures: '故障中心', health: '系统健康', tasks: '任务队列', adminRoles: '管理员权限', audit: '审计记录', logout: '退出登录', systemOperations: '系统运营', refresh: '刷新', usage30: '最近 30 天',
    translationUsage: '翻译用量', recentErrors: '最近错误', failureOverview: '失败概览', nonDeleted: '未注销', active: '正常', disabled: '已停用',
    deleted: '已注销', search: '查询', searchUsers: '搜索姓名、公司、邮箱或电话', identity: '用户', adminPermission: '管理权限', status: '状态', lastSeen: '最近活动',
    devices: '设备', actions: '操作', searchMeetings: '搜索会议、主持人、客户或 ID', allStatuses: '全部状态', waiting: '等待中', inProgress: '进行中',
    ended: '已结束', expired: '已过期', meeting: '会议', host: '主持人', participants: '参会者', messages: '消息', immutableTrail: '不可变更记录',
    privilegedActions: '管理操作记录', time: '时间', operator: '操作人', action: '动作', target: '对象', details: '详情', oneTimeReset: '一次性密码重置',
    resetWarning: '该链接只显示一次。请通过受信渠道发送给用户，切勿写入工单或聊天群。', resetLink: '重置链接', copyLink: '复制链接', close: '关闭',
    totalUsers: '用户总数', activeMeetings: '活跃会议', onlineNow: '当前在线', failedTranslations: '翻译失败', activeAccounts: '正常账号', newToday: '24 小时新增',
    allMeetings: '全部会议', processing: '处理中', noData: '暂无数据', finalMessages: '完成消息', providers: '服务商', sourceLanguages: '原文语言',
    newUsers: '新增用户', newMeetings: '新增会议', previous: '上一页', next: '下一页', pageOf: '第 {page} / {total} 页', online: '在线', offline: '离线',
    admin: '系统管理员', regularUser: '普通用户', enable: '启用', disable: '停用', revoke: '强制退出', reset: '重置密码',
    view: '查看', endMeeting: '结束会议', confirmDisable: '确定立即停用该账号并撤销所有会话吗？', confirmEnable: '确定启用该账号吗？',
    confirmRevoke: '确定让该用户的所有设备立即退出吗？', confirmReset: '确定签发新的一次性密码重置链接吗？', confirmEnd: '确定立即结束该会议吗？所有参会者将无法继续发言。',
    operationDone: '操作已完成', linkCopied: '链接已复制', loginFailed: '登录失败', adminRequired: '该账号没有服务器管理员权限',
    networkError: '网络请求失败', sessionExpired: '登录已失效，请重新登录', participantsList: '参会人员', createdAt: '创建时间', expiresAt: '过期时间', company: '公司', languageShort: '语言',
    viewUser: '查看详情', devicesList: '设备与会话', authenticatedAt: '登录时间', revokedAt: '撤销时间', conversationsCount: '创建会议', participationCount: '参会次数',
    searchFailures: '搜索错误码、服务商、会议或消息 ID', providerFilter: '服务商', errorCode: '错误码', provider: '服务商', message: '消息',
    searchAudit: '搜索动作、对象、操作人或 ID', allTargets: '全部对象',
    runtimeDetails: '运行详情', database: '数据库', realtime: '实时通信', queues: '队列积压', latency: '延迟', allTasks: '全部任务', audioDeletion: '音频清理', summaryEmail: '纪要邮件', taskType: '任务类型', attempts: '尝试次数', retry: '安全重试', retryReason: '请输入重试原因（至少 3 个字）', adminRoleManagement: '管理员职责分级', adminRoleHint: '这里只调整已有管理员职责，不能把普通用户提升为管理员。', adminRole: '职责', saveRole: '保存职责', roleReason: '请输入权限调整原因（至少 3 个字）', serviceVersion: '服务版本', translationProvider: '翻译服务', emailProvider: '邮件服务', storageProvider: '音频存储',
    emailCenter: '邮件通知', glossaryCenter: '公共术语', qualityCenter: '翻译质量', dataGovernance: '数据治理', settings: '系统配置', searchEmail: '搜索任务或会议 ID', recipients: '收件人', delivery: '发送结果', searchGlossary: '搜索原词、译词或分类', allDirections: '全部方向', globalTermsHint: '公共术语应用于所有用户，用户私人术语优先。', addTerm: '新增术语', direction: '方向', sourceTerm: '原词', targetTerm: '译词', category: '分类', correctionType: '类型', subject: '数据主体', steps: '处理步骤', businessSettings: '业务配置', settingsHint: '这里只提供安全业务开关，不显示任何密钥或数据库地址。', save: '保存', inspectReason: '请输入查看敏感质量内容的原因', confirmCorrection: '确认纠错', rejectCorrection: '拒绝纠错', decisionReason: '请输入审核原因', termPrompt: '请输入：源语言,目标语言,原词,译词,分类',
  },
  ru: {
    loginTitle: 'Панель управления сервером', loginHint: 'Войдите с разрешённой учётной записью. Права администратора проверяет сервер.',
    email: 'Email', password: 'Пароль', signIn: 'Войти', language: 'Язык', overview: 'Обзор', users: 'Пользователи', meetings: 'Конференции',
    failures: 'Сбои', health: 'Состояние', tasks: 'Очереди', adminRoles: 'Администраторы', audit: 'Аудит', logout: 'Выйти', systemOperations: 'Системные операции', refresh: 'Обновить', usage30: 'Последние 30 дней', translationUsage: 'Объём перевода',
    recentErrors: 'Недавние ошибки', failureOverview: 'Обзор сбоев', nonDeleted: 'Не удалены', active: 'Активен', disabled: 'Отключён', deleted: 'Удалён',
    search: 'Найти', searchUsers: 'Имя, компания, email или телефон', identity: 'Пользователь', adminPermission: 'Права управления', status: 'Статус', lastSeen: 'Последняя активность',
    devices: 'Устройства', actions: 'Действия', searchMeetings: 'Конференция, ведущий, клиент или ID', allStatuses: 'Все статусы', waiting: 'Ожидание', inProgress: 'Идёт',
    ended: 'Завершена', expired: 'Истекла', meeting: 'Конференция', host: 'Ведущий', participants: 'Участники', messages: 'Сообщения', immutableTrail: 'Неизменяемый журнал',
    privilegedActions: 'Административные действия', time: 'Время', operator: 'Оператор', action: 'Действие', target: 'Объект', details: 'Детали', oneTimeReset: 'Одноразовый сброс пароля',
    resetWarning: 'Ссылка показывается один раз. Передайте её по доверенному каналу.', resetLink: 'Ссылка сброса', copyLink: 'Копировать', close: 'Закрыть',
    totalUsers: 'Всего пользователей', activeMeetings: 'Активные встречи', onlineNow: 'Сейчас онлайн', failedTranslations: 'Ошибки перевода', activeAccounts: 'Активные учётные записи',
    newToday: 'Новые за 24 часа', allMeetings: 'Все конференции', processing: 'В обработке', noData: 'Нет данных', finalMessages: 'Готовые сообщения', providers: 'Провайдеры',
    sourceLanguages: 'Языки исходного текста', newUsers: 'Новые пользователи', newMeetings: 'Новые конференции', previous: 'Назад', next: 'Далее', pageOf: 'Стр. {page} / {total}', online: 'Онлайн', offline: 'Офлайн',
    admin: 'Системный администратор', regularUser: 'Обычный пользователь', enable: 'Включить', disable: 'Отключить', revoke: 'Завершить сессии', reset: 'Сбросить пароль',
    view: 'Открыть', endMeeting: 'Завершить', confirmDisable: 'Отключить учётную запись и завершить все сессии?', confirmEnable: 'Включить учётную запись?',
    confirmRevoke: 'Немедленно завершить все сесии этого пользователя?', confirmReset: 'Выдать новую одноразовую ссылку сброса?', confirmEnd: 'Завершить конференцию? Участники больше не смогут говорить.',
    operationDone: 'Операция выполнена', linkCopied: 'Ссылка скопирована', loginFailed: 'Не удалось войти', adminRequired: 'Нет прав системного администратора',
    networkError: 'Сбой сетевого запроса', sessionExpired: 'Сессия истекла. Войдите снова.', participantsList: 'Список участников', createdAt: 'Создана', expiresAt: 'Истекает', company: 'Компания', languageShort: 'Язык',
    viewUser: 'Подробнее', devicesList: 'Устройства и сессии', authenticatedAt: 'Вход', revokedAt: 'Отозвана', conversationsCount: 'Создано встреч', participationCount: 'Участий',
    searchFailures: 'Код, провайдер, встреча или ID сообщения', providerFilter: 'Провайдер', errorCode: 'Код ошибки', provider: 'Провайдер', message: 'Сообщение',
    searchAudit: 'Действие, объект, оператор или ID', allTargets: 'Все объекты',
    runtimeDetails: 'Сведения о работе', database: 'База данных', realtime: 'Связь в реальном времени', queues: 'Очереди', latency: 'Задержка', allTasks: 'Все задачи', audioDeletion: 'Удаление аудио', summaryEmail: 'Письма с итогами', taskType: 'Тип задачи', attempts: 'Попытки', retry: 'Повторить безопасно', retryReason: 'Укажите причину повтора', adminRoleManagement: 'Роли администраторов', adminRoleHint: 'Здесь меняются только роли существующих администраторов.', adminRole: 'Роль', saveRole: 'Сохранить', roleReason: 'Укажите причину изменения роли', serviceVersion: 'Версия', translationProvider: 'Перевод', emailProvider: 'Почта', storageProvider: 'Хранилище',
    emailCenter: 'Уведомления', glossaryCenter: 'Общий глоссарий', qualityCenter: 'Качество', dataGovernance: 'Управление данными', settings: 'Настройки', searchEmail: 'Задача или ID встречи', recipients: 'Получатели', delivery: 'Доставка', searchGlossary: 'Исходный термин, перевод или категория', allDirections: 'Все направления', globalTermsHint: 'Общие термины применяются ко всем, личные имеют приоритет.', addTerm: 'Добавить', direction: 'Направление', sourceTerm: 'Исходный термин', targetTerm: 'Перевод', category: 'Категория', correctionType: 'Тип', subject: 'Субъект', steps: 'Шаги', businessSettings: 'Бизнес-настройки', settingsHint: 'Здесь нет секретов и адресов баз данных.', save: 'Сохранить', inspectReason: 'Укажите причину просмотра содержимого', confirmCorrection: 'Подтвердить', rejectCorrection: 'Отклонить', decisionReason: 'Укажите причину решения', termPrompt: 'Введите: исходный язык,целевой язык,термин,перевод,категория',
  },
};

const $ = (selector) => document.querySelector(selector);
const state = {
  language: localStorage.getItem('translator.admin.language') || (navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'zh'),
  view: 'overview',
  admin: null,
  usersPage: 1,
  conversationsPage: 1,
  failuresPage: 1,
  tasksPage: 1,
  emailPage: 1, glossaryPage: 1, qualityPage: 1, governancePage: 1,
  auditPage: 1,
};
const tokenKeys = { access: 'translator.admin.access', refresh: 'translator.admin.refresh' };

function t(key, values = {}) {
  let value = translations[state.language]?.[key] || translations.zh[key] || key;
  for (const [name, replacement] of Object.entries(values)) value = value.replace(`{${name}}`, String(replacement));
  return value;
}

function applyLanguage() {
  document.documentElement.lang = state.language === 'ru' ? 'ru' : 'zh-CN';
  document.querySelectorAll('[data-i18n]').forEach((node) => { node.textContent = t(node.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => { node.placeholder = t(node.dataset.i18nPlaceholder); });
  document.querySelectorAll('.languageSelect').forEach((select) => { select.value = state.language; });
  $('#pageTitle').textContent = t(state.view === 'conversations' ? 'meetings' : state.view);
}

function setLanguage(language) {
  state.language = language === 'ru' ? 'ru' : 'zh';
  localStorage.setItem('translator.admin.language', state.language);
  applyLanguage();
  if (!$('#consoleView').classList.contains('hidden')) void loadCurrentView();
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(state.language === 'ru' ? 'ru-RU' : 'zh-CN', {
    dateStyle: 'short', timeStyle: 'short',
  }).format(date);
}

function stored(key) { return sessionStorage.getItem(key); }
function clearCredentials() { sessionStorage.removeItem(tokenKeys.access); sessionStorage.removeItem(tokenKeys.refresh); }
function deviceId() {
  const key = 'translator.admin.device';
  let id = localStorage.getItem(key);
  if (!id) {
    id = `admin-web-${crypto.randomUUID()}`;
    localStorage.setItem(key, id);
  }
  return id;
}

let refreshInFlight = null;
let terminalAuthFailureHandled = false;

function refreshSession() {
  if (refreshInFlight) return refreshInFlight;
  const request = performRefresh().finally(() => {
    if (refreshInFlight === request) refreshInFlight = null;
  });
  refreshInFlight = request;
  return request;
}

async function performRefresh() {
  const refreshToken = stored(tokenKeys.refresh);
  if (!refreshToken) {
    clearCredentials();
    return false;
  }
  const response = await fetch('/v1/auth/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken, deviceId: deviceId() }),
  });
  if (!response.ok) {
    clearCredentials();
    return false;
  }
  let result;
  try { result = await response.json(); } catch { result = null; }
  if (
    result?.ok !== true ||
    typeof result.data?.accessToken !== 'string' || !result.data.accessToken ||
    typeof result.data?.refreshToken !== 'string' || !result.data.refreshToken
  ) {
    clearCredentials();
    return false;
  }
  sessionStorage.setItem(tokenKeys.access, result.data.accessToken);
  sessionStorage.setItem(tokenKeys.refresh, result.data.refreshToken);
  terminalAuthFailureHandled = false;
  return true;
}

async function api(path, options = {}, allowRefresh = true) {
  const headers = new Headers(options.headers || {});
  const token = stored(tokenKeys.access);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body !== undefined && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  let response;
  try {
    response = await fetch(path, { ...options, headers, body: options.body === undefined || options.body instanceof FormData ? options.body : JSON.stringify(options.body) });
  } catch {
    throw new Error(t('networkError'));
  }
  if (response.status === 401 && allowRefresh && await refreshSession()) return api(path, options, false);
  let result;
  try { result = await response.json(); } catch { result = { ok: false, message: response.statusText }; }
  if (!response.ok || !result.ok) {
    const error = new Error(result.message || `${response.status}`);
    error.code = result.code;
    error.status = response.status;
    if (response.status === 401 || (response.status === 403 && error.code === 'SYSTEM_ADMIN_REQUIRED')) {
      handleAdminAuthFailure(error);
    }
    throw error;
  }
  return result.data;
}

let toastTimer;
function toast(message, error = false) {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), 3800);
}

function showLogin(message = '') {
  state.admin = null;
  $('#consoleView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
  $('#loginStatus').textContent = message;
  $('#loginPassword').value = '';
}

function handleAdminAuthFailure(error) {
  // Concurrent API calls share one refresh. Only the first terminal auth
  // failure transitions the visible console; later failures are marked as
  // handled so they cannot overwrite the login page with duplicate toasts.
  clearCredentials();
  error.authHandled = true;
  if (terminalAuthFailureHandled) return;
  terminalAuthFailureHandled = true;
  showLogin(error.code === 'SYSTEM_ADMIN_REQUIRED' ? t('adminRequired') : t('sessionExpired'));
}

function showConsole(admin) {
  terminalAuthFailureHandled = false;
  state.admin = admin;
  $('#loginView').classList.add('hidden');
  $('#consoleView').classList.remove('hidden');
  const box = $('#adminIdentity');
  box.replaceChildren(element('strong', '', admin.displayName), element('span', '', `${admin.email || ''} · ${admin.adminRole || 'UNASSIGNED'}`));
  document.querySelectorAll('.nav-button').forEach((button) => {
    button.classList.toggle('hidden', !canView(button.dataset.view));
  });
  if (!canView(state.view)) state.view = 'overview';
  applyLanguage();
  void loadCurrentView();
}

function adminRole() { return state.admin?.adminRole || 'UNASSIGNED'; }
function canView(view) {
  const role = adminRole();
  if (view === 'admins') return role === 'SUPER_ADMIN';
  if (view === 'settings') return role === 'SUPER_ADMIN';
  if (view === 'email') return ['SUPER_ADMIN', 'OPERATIONS', 'SUPPORT'].includes(role);
  if (view === 'glossary' || view === 'quality') return ['SUPER_ADMIN', 'OPERATIONS', 'QUALITY'].includes(role);
  if (view === 'governance') return ['SUPER_ADMIN', 'OPERATIONS', 'AUDITOR'].includes(role);
  if (view === 'audit') return ['SUPER_ADMIN', 'OPERATIONS', 'AUDITOR'].includes(role);
  return true;
}
function can(capability) {
  const roles = {
    users: ['SUPER_ADMIN', 'OPERATIONS', 'SUPPORT'], meetings: ['SUPER_ADMIN', 'OPERATIONS', 'SUPPORT'],
    failures: ['SUPER_ADMIN', 'OPERATIONS', 'QUALITY'], tasks: ['SUPER_ADMIN', 'OPERATIONS'],
  };
  return roles[capability]?.includes(adminRole()) ?? false;
}

async function authenticateConsole() {
  if (!stored(tokenKeys.access) && !stored(tokenKeys.refresh)) return showLogin();
  try { showConsole(await api('/v1/admin/me')); }
  catch (error) {
    if (error.authHandled) return;
    clearCredentials();
    showLogin(error.code === 'SYSTEM_ADMIN_REQUIRED' ? t('adminRequired') : error.message);
  }
}

function metricCard(label, value, note, alert = false) {
  const card = element('article', `metric-card${alert ? ' alert' : ''}`);
  card.append(element('div', 'metric-label', label), element('div', 'metric-value', value), element('div', 'metric-note', note));
  return card;
}

function listRow(label, value, kind = 'usage') {
  const row = element('div', `${kind}-row`);
  row.append(element('span', '', label), element('strong', '', value));
  return row;
}

async function loadOverview() {
  const [overview, metrics] = await Promise.all([api('/v1/admin/overview'), api('/v1/admin/metrics?days=30')]);
  $('#overviewCards').replaceChildren(
    metricCard(t('totalUsers'), overview.users.total, `${t('activeAccounts')}: ${overview.users.active} · ${t('newToday')}: ${overview.users.new24h}`),
    metricCard(t('activeMeetings'), overview.conversations.active, `${t('allMeetings')}: ${overview.conversations.total} · ${t('waiting')}: ${overview.conversations.waiting}`),
    metricCard(t('onlineNow'), overview.participants.online, `${t('processing')}: ${overview.messages.processing}`),
    metricCard(t('failedTranslations'), overview.messages.failed, `${t('messages')}: ${overview.messages.total}`, overview.messages.failed > 0),
  );
  const usage = $('#usageMetrics');
  const finalCount = metrics.messages.byStatus.find((item) => item.status === 'FINAL')?.count || 0;
  usage.replaceChildren(
    listRow(t('finalMessages'), finalCount),
    listRow(t('newUsers'), metrics.newUsers),
    listRow(t('newMeetings'), metrics.newConversations),
    ...metrics.messages.byProvider.map((item) => listRow(`${t('providers')} · ${item.provider || '—'}`, item.count)),
    ...metrics.messages.bySourceLanguage.map((item) => listRow(`${t('sourceLanguages')} · ${item.sourceLanguage}`, item.count)),
  );
  const errors = $('#errorMetrics');
  const rows = metrics.errors.byCode.map((item) => listRow(item.errorCode || 'UNKNOWN', item.count, 'error'));
  errors.replaceChildren(...(rows.length ? rows : [element('div', 'empty', t('noData'))]));
}

function badge(value, extra = '') {
  const labels = { ACTIVE: t('active'), DISABLED: t('disabled'), DELETED: t('deleted'), WAITING: t('waiting'), ENDED: t('ended'), EXPIRED: t('expired') };
  return element('span', `badge ${String(value).toLowerCase()} ${extra}`, labels[value] || value);
}

function actionButton(label, action, id, danger = false) {
  const button = element('button', danger ? 'danger' : 'ghost', label);
  button.type = 'button'; button.dataset.action = action; button.dataset.id = id;
  return button;
}

function identityCell(title, subtitle, id) {
  const cell = element('td', 'identity-cell');
  cell.append(element('strong', '', title || '—'), element('span', '', subtitle || '—'));
  if (id) cell.append(element('span', 'mono', id));
  return cell;
}

function renderPagination(container, payload, kind) {
  const previous = actionButton(t('previous'), `${kind}-page`, String(payload.page - 1));
  previous.disabled = payload.page <= 1;
  const next = actionButton(t('next'), `${kind}-page`, String(payload.page + 1));
  next.disabled = payload.page >= Math.max(1, payload.totalPages);
  container.replaceChildren(previous, element('span', '', t('pageOf', { page: payload.page, total: Math.max(1, payload.totalPages) })), next);
}

async function loadUsers() {
  const query = new URLSearchParams({ page: String(state.usersPage), pageSize: '25' });
  const q = $('#userSearch').value.trim(); const status = $('#userStatus').value;
  if (q) query.set('q', q); if (status) query.set('status', status);
  const data = await api(`/v1/admin/users?${query}`);
  const body = $('#usersBody'); body.replaceChildren();
  for (const user of data.items) {
    const row = element('tr');
    row.append(identityCell(user.displayName, [user.company, user.email].filter(Boolean).join(' · '), user.id));
    const permission = element('td'); permission.append(badge(user.isSystemAdmin ? t('admin') : t('regularUser'))); row.append(permission);
    const statusCell = element('td'); statusCell.append(badge(user.status), document.createTextNode(' '), badge(user.online ? t('online') : t('offline'), user.online ? 'online' : '')); row.append(statusCell);
    row.append(element('td', '', formatDate(user.lastSeenAt)), element('td', '', String(user.activeDeviceCount)));
    const actions = element('td', 'actions');
    actions.append(actionButton(t('viewUser'), 'view-user', user.id));
    if (user.status !== 'DELETED') {
      if (can('users') && user.status === 'ACTIVE' && !user.isSystemAdmin && user.id !== state.admin.id) actions.append(actionButton(t('disable'), 'disable-user', user.id, true));
      if (can('users') && user.status === 'DISABLED') actions.append(actionButton(t('enable'), 'enable-user', user.id));
      if (can('users')) actions.append(actionButton(t('revoke'), 'revoke-user', user.id), actionButton(t('reset'), 'reset-user', user.id));
    }
    row.append(actions); body.append(row);
  }
  if (!data.items.length) { const row = element('tr'); const cell = element('td', 'empty', t('noData')); cell.colSpan = 6; row.append(cell); body.append(row); }
  renderPagination($('#usersPagination'), data, 'users');
}

async function viewUser(id) {
  const data = await api(`/v1/admin/users/${encodeURIComponent(id)}`);
  $('#dialogTitle').textContent = data.displayName || data.email || data.id;
  const content = $('#dialogContent');
  const grid = element('div', 'detail-grid');
  grid.append(
    detailItem('ID', data.id), detailItem(t('status'), data.status), detailItem(t('email'), data.email),
    detailItem(t('company'), data.company), detailItem(t('languageShort'), data.preferredLanguage), detailItem(t('createdAt'), formatDate(data.createdAt)),
    detailItem(t('conversationsCount'), data._count?.conversations ?? 0), detailItem(t('participationCount'), data._count?.participants ?? 0),
    detailItem(t('messages'), (data.messageStatus || []).reduce((sum, item) => sum + item.count, 0)), detailItem('Contacts', data._count?.contacts ?? 0),
  );
  const heading = element('h3', '', t('devicesList'));
  const roster = element('div', 'roster');
  for (const device of data.devices) {
    const row = element('div', 'roster-row');
    const status = device.revokedAt ? `${t('revokedAt')}: ${formatDate(device.revokedAt)}` : `${t('lastSeen')}: ${formatDate(device.lastSeenAt)}`;
    row.append(element('span', '', `${device.platform} · ${device.deviceId}`), element('span', '', status));
    roster.append(row);
  }
  if (!data.devices.length) roster.append(element('div', 'empty', t('noData')));
  const auditHeading = element('h3', '', t('privilegedActions'));
  const timeline = element('div', 'roster');
  for (const operation of data.recentOperations || []) {
    const row = element('div', 'roster-row'); row.append(element('span', '', operation.action), element('span', '', `${operation.actor?.displayName || '—'} · ${formatDate(operation.createdAt)}`)); timeline.append(row);
  }
  content.replaceChildren(grid, heading, roster, auditHeading, timeline);
  $('#detailDialog').showModal();
}

async function loadConversations() {
  const query = new URLSearchParams({ page: String(state.conversationsPage), pageSize: '25' });
  const q = $('#conversationSearch').value.trim(); const status = $('#conversationStatus').value;
  if (q) query.set('q', q); if (status) query.set('status', status);
  const data = await api(`/v1/admin/conversations?${query}`);
  const body = $('#conversationsBody'); body.replaceChildren();
  for (const meeting of data.items) {
    const row = element('tr');
    row.append(identityCell(meeting.title || meeting.contact?.displayName || '—', formatDate(meeting.createdAt), meeting.id));
    row.append(identityCell(meeting.owner?.displayName, meeting.owner?.email));
    const statusCell = element('td'); statusCell.append(badge(meeting.status)); row.append(statusCell);
    row.append(element('td', '', meeting.participantCount), element('td', '', meeting.messageCount));
    const actions = element('td', 'actions'); actions.append(actionButton(t('view'), 'view-meeting', meeting.id));
    if (can('meetings') && (meeting.status === 'ACTIVE' || meeting.status === 'WAITING')) actions.append(actionButton(t('endMeeting'), 'end-meeting', meeting.id, true));
    row.append(actions); body.append(row);
  }
  if (!data.items.length) { const row = element('tr'); const cell = element('td', 'empty', t('noData')); cell.colSpan = 6; row.append(cell); body.append(row); }
  renderPagination($('#conversationsPagination'), data, 'conversations');
}

async function loadFailures() {
  const query = new URLSearchParams({ page: String(state.failuresPage), pageSize: '25' });
  const q = $('#failureSearch').value.trim(); const provider = $('#failureProvider').value.trim();
  if (q) query.set('q', q); if (provider) query.set('provider', provider);
  const data = await api(`/v1/admin/failures?${query}`);
  const body = $('#failuresBody'); body.replaceChildren();
  for (const failure of data.items) {
    const row = element('tr');
    row.append(
      element('td', '', formatDate(failure.updatedAt)),
      element('td', 'mono', failure.errorCode || 'UNKNOWN'),
      element('td', '', failure.provider || '—'),
      element('td', 'mono', failure.conversationId),
      element('td', 'mono', `${failure.id} · #${failure.sequence}`),
      element('td', 'message-detail', failure.errorMessage || '—'),
    );
    const actions = element('td', 'actions');
    if (can('failures')) actions.append(actionButton(t('retry'), 'retry-failure', failure.id));
    row.append(actions);
    body.append(row);
  }
  if (!data.items.length) { const row = element('tr'); const cell = element('td', 'empty', t('noData')); cell.colSpan = 7; row.append(cell); body.append(row); }
  renderPagination($('#failuresPagination'), data, 'failures');
}

async function retryFailure(id) {
  const reason = prompt(t('retryReason'))?.trim();
  if (!reason) return;
  await api(`/v1/admin/failures/${encodeURIComponent(id)}/retry`, { method: 'POST', body: { reason } });
  toast(t('operationDone')); await loadFailures();
}

async function loadHealth() {
  const data = await api('/v1/admin/health');
  $('#healthCards').replaceChildren(
    metricCard(t('database'), data.database.status, `${t('latency')}: ${data.database.latencyMs} ms`),
    metricCard(t('realtime'), data.realtime.status, ''),
    metricCard(t('queues'), data.queues.audioPending + data.queues.emailPending, `${t('failedTranslations')}: ${data.queues.audioFailed + data.queues.emailFailed}`, data.queues.audioFailed + data.queues.emailFailed > 0),
    metricCard(t('processing'), data.queues.processingMessages, `stale: ${data.queues.staleMessages}`, data.queues.staleMessages > 0),
  );
  $('#healthDetails').replaceChildren(
    detailItem(t('serviceVersion'), data.service.version), detailItem(t('translationProvider'), data.providers.translation),
    detailItem(t('emailProvider'), data.providers.email), detailItem(t('storageProvider'), data.providers.storage),
    detailItem(t('audioDeletion'), `${data.queues.audioPending} / failed ${data.queues.audioFailed}`),
    detailItem(t('summaryEmail'), `${data.queues.emailPending} / failed ${data.queues.emailFailed}`),
  );
}

async function loadTasks() {
  const query = new URLSearchParams({ page: String(state.tasksPage), pageSize: '25' });
  const type = $('#taskType').value; if (type) query.set('type', type);
  const data = await api(`/v1/admin/tasks?${query}`);
  const body = $('#tasksBody'); body.replaceChildren();
  for (const task of data.items) {
    const row = element('tr');
    row.append(element('td', '', formatDate(task.updatedAt)), element('td', 'mono', task.type));
    const status = element('td'); status.append(badge(task.status)); row.append(status);
    row.append(element('td', '', task.attempts), element('td', 'message-detail', task.errorMessage || task.errorCode || '—'));
    const actions = element('td', 'actions');
    if (can('tasks') && task.status === 'FAILED' && task.errorCode !== 'EMAIL_DELIVERY_UNKNOWN_RETRY_EXPIRED') actions.append(actionButton(t('retry'), 'retry-task', `${task.type}:${task.id}`));
    row.append(actions); body.append(row);
  }
  if (!data.items.length) { const row = element('tr'); const cell = element('td', 'empty', t('noData')); cell.colSpan = 6; row.append(cell); body.append(row); }
  renderPagination($('#tasksPagination'), data, 'tasks');
}

async function retryTask(value) {
  const separator = value.indexOf(':'); const type = value.slice(0, separator); const id = value.slice(separator + 1);
  const reason = prompt(t('retryReason'))?.trim(); if (!reason) return;
  await api(`/v1/admin/tasks/${encodeURIComponent(type)}/${encodeURIComponent(id)}/retry`, { method: 'POST', body: { reason } });
  toast(t('operationDone')); await loadTasks();
}

async function loadAdmins() {
  const data = await api('/v1/admin/admins'); const body = $('#adminsBody'); body.replaceChildren();
  const roles = ['SUPER_ADMIN', 'OPERATIONS', 'SUPPORT', 'QUALITY', 'AUDITOR', 'VIEWER'];
  for (const admin of data.items) {
    const row = element('tr'); row.append(identityCell(admin.displayName, admin.email, admin.id));
    const roleCell = element('td'); const select = element('select'); select.dataset.adminRole = admin.id;
    for (const role of roles) { const option = element('option', '', role); option.value = role; option.selected = role === admin.adminRole; select.append(option); }
    roleCell.append(select); row.append(roleCell);
    const status = element('td'); status.append(badge(admin.status)); row.append(status, element('td', '', formatDate(admin.createdAt)));
    const actions = element('td', 'actions'); actions.append(actionButton(t('saveRole'), 'save-admin-role', admin.id)); row.append(actions); body.append(row);
  }
}

async function saveAdminRole(id) {
  const role = document.querySelector(`[data-admin-role="${CSS.escape(id)}"]`).value;
  const reason = prompt(t('roleReason'))?.trim(); if (!reason) return;
  await api(`/v1/admin/admins/${encodeURIComponent(id)}/role`, { method: 'PATCH', body: { role, reason } });
  toast(t('operationDone')); await loadAdmins();
}

async function loadEmail() {
  const query = new URLSearchParams({ page: String(state.emailPage), pageSize: '25' }); const q = $('#emailSearch').value.trim(); const status = $('#emailStatus').value; if (q) query.set('q', q); if (status) query.set('status', status);
  const data = await api(`/v1/admin/email/distributions?${query}`); const body = $('#emailBody'); body.replaceChildren();
  for (const item of data.items) { const row = element('tr'); row.append(element('td', '', formatDate(item.createdAt)), identityCell(item.conversation?.title || item.conversationId, item.id)); const statusCell = element('td'); statusCell.append(badge(item.status)); row.append(statusCell, element('td', '', item.recipientCount), element('td', '', `${item.sentCount} / ${item.failedCount}`)); const actions = element('td', 'actions'); actions.append(actionButton(t('view'), 'view-email', item.id)); row.append(actions); body.append(row); }
  if (!data.items.length) { const row = element('tr'); const cell = element('td', 'empty', t('noData')); cell.colSpan = 6; row.append(cell); body.append(row); } renderPagination($('#emailPagination'), data, 'email');
}
async function viewEmail(id) {
  const data = await api(`/v1/admin/email/distributions/${encodeURIComponent(id)}`); $('#dialogTitle').textContent = data.id; const content = $('#dialogContent'); const grid = element('div', 'detail-grid'); grid.append(detailItem(t('status'), data.status), detailItem(t('recipients'), data.recipientCount), detailItem('Sent', data.sentCount), detailItem('Failed', data.failedCount)); const roster = element('div', 'roster'); for (const recipient of data.recipients) { const row = element('div', 'roster-row'); row.append(element('span', '', `${recipient.recipientDisplayName} · ${recipient.emailHint || '—'}`), element('span', '', `${recipient.status} · ${recipient.errorCode || ''}`)); roster.append(row); } content.replaceChildren(grid, roster); $('#detailDialog').showModal();
}

async function loadGlossary() {
  const query = new URLSearchParams({ page: String(state.glossaryPage), pageSize: '25' }); const q = $('#glossarySearch').value.trim(); const direction = $('#glossaryDirection').value; if (q) query.set('q', q); if (direction) { const [source, target] = direction.split(':'); query.set('sourceLanguage', source); query.set('targetLanguage', target); }
  const data = await api(`/v1/admin/system-glossary?${query}`); const body = $('#glossaryBody'); body.replaceChildren(); for (const item of data.items) { const row = element('tr'); row.append(element('td', '', `${item.sourceLanguage} → ${item.targetLanguage}`), element('td', '', item.sourceTerm), element('td', '', item.targetTerm), element('td', '', item.category || '—')); const status = element('td'); status.append(badge(item.enabled ? 'ACTIVE' : 'DISABLED')); row.append(status); const actions = element('td', 'actions'); if (item.enabled) actions.append(actionButton(t('disable'), 'disable-term', item.id, true)); row.append(actions); body.append(row); } if (!data.items.length) { const row = element('tr'); const cell = element('td', 'empty', t('noData')); cell.colSpan = 6; row.append(cell); body.append(row); } renderPagination($('#glossaryPagination'), data, 'glossary');
}
async function addGlossary() { const raw = prompt(t('termPrompt'))?.trim(); if (!raw) return; const [sourceLanguage, targetLanguage, sourceTerm, targetTerm, category] = raw.split(',').map((value) => value.trim()); await api('/v1/admin/system-glossary', { method: 'POST', body: { sourceLanguage, targetLanguage, sourceTerm, targetTerm, category } }); toast(t('operationDone')); await loadGlossary(); }
async function disableTerm(id) { if (!confirm(t('confirmDisable'))) return; await api(`/v1/admin/system-glossary/${encodeURIComponent(id)}`, { method: 'DELETE' }); toast(t('operationDone')); await loadGlossary(); }

async function loadQuality() {
  const query = new URLSearchParams({ page: String(state.qualityPage), pageSize: '25' }); const status = $('#qualityStatus').value; if (status) query.set('status', status); const data = await api(`/v1/admin/quality/corrections?${query}`); const body = $('#qualityBody'); body.replaceChildren(); for (const item of data.items) { const row = element('tr'); row.append(element('td', '', formatDate(item.createdAt)), element('td', 'mono', item.conversationId), element('td', '', item.kind), element('td', '', item.actorDisplayName)); const statusCell = element('td'); statusCell.append(badge(item.status)); row.append(statusCell); const actions = element('td', 'actions'); actions.append(actionButton(t('view'), 'view-quality', item.id)); row.append(actions); body.append(row); } if (!data.items.length) { const row = element('tr'); const cell = element('td', 'empty', t('noData')); cell.colSpan = 6; row.append(cell); body.append(row); } renderPagination($('#qualityPagination'), data, 'quality');
}
async function viewQuality(id) { const reason = prompt(t('inspectReason'))?.trim(); if (!reason) return; const data = await api(`/v1/admin/quality/corrections/${encodeURIComponent(id)}?${new URLSearchParams({ reason })}`); $('#dialogTitle').textContent = `${data.kind} · ${data.status}`; const content = $('#dialogContent'); const grid = element('div', 'detail-grid'); grid.append(detailItem('Original', data.message.sourceText), detailItem('Current translation', data.message.translatedText), detailItem('Proposed source', data.proposedSourceText), detailItem('Proposed translation', data.proposedTranslatedText)); const actions = element('div', 'dialog-actions'); if (data.status === 'PENDING') actions.append(actionButton(t('confirmCorrection'), 'decide-quality-confirm', id), actionButton(t('rejectCorrection'), 'decide-quality-reject', id, true)); content.replaceChildren(grid, actions); $('#detailDialog').showModal(); }
async function decideQuality(id, decision) { const reason = prompt(t('decisionReason'))?.trim(); if (!reason) return; await api(`/v1/admin/quality/corrections/${encodeURIComponent(id)}/decision`, { method: 'PATCH', body: { decision, reason } }); $('#detailDialog').close(); toast(t('operationDone')); await loadQuality(); }

async function loadGovernance() { const query = new URLSearchParams({ page: String(state.governancePage), pageSize: '25' }); const status = $('#governanceStatus').value; if (status) query.set('status', status); const data = await api(`/v1/admin/governance/deletions?${query}`); $('#governanceCards').replaceChildren(metricCard('Deleted users', data.summary.deletedUsers, ''), metricCard('Deletion records', data.total, ''), metricCard('Pending assets', data.summary.pendingAssets, '', data.summary.pendingAssets > 0)); const body = $('#governanceBody'); body.replaceChildren(); for (const item of data.items) { const row = element('tr'); row.append(element('td', '', formatDate(item.requestedAt)), element('td', 'mono', `${item.subjectType} · ${item.subjectId}`)); const statusCell = element('td'); statusCell.append(badge(item.status)); row.append(statusCell, element('td', 'mono', JSON.stringify(item.steps || {})), element('td', 'message-detail', item.lastError || '—')); body.append(row); } if (!data.items.length) { const row = element('tr'); const cell = element('td', 'empty', t('noData')); cell.colSpan = 5; row.append(cell); body.append(row); } renderPagination($('#governancePagination'), data, 'governance'); }

async function loadSettings() { const data = await api('/v1/admin/settings'); const list = $('#settingsList'); list.replaceChildren(); for (const item of data.items) { const row = element('div', 'setting-row'); row.append(element('strong', '', item.key)); let input; if (typeof item.value === 'boolean') { input = element('select'); for (const value of ['true', 'false']) { const option = element('option', '', value); option.value = value; option.selected = String(item.value) === value; input.append(option); } } else { input = element('input'); input.value = item.value; } input.dataset.settingInput = item.key; input.dataset.version = item.version; row.append(input, actionButton(t('save'), 'save-setting', item.key)); list.append(row); } }
async function saveSetting(key) { const input = document.querySelector(`[data-setting-input="${CSS.escape(key)}"]`); const value = input.tagName === 'SELECT' ? input.value === 'true' : input.value; const reason = prompt(t('roleReason'))?.trim(); if (!reason) return; await api(`/v1/admin/settings/${encodeURIComponent(key)}`, { method: 'PATCH', body: { value, expectedVersion: Number(input.dataset.version), reason } }); toast(t('operationDone')); await loadSettings(); }

async function loadAudit() {
  const query = new URLSearchParams({ page: String(state.auditPage), pageSize: '25' });
  const q = $('#auditSearch').value.trim(); const targetType = $('#auditTargetType').value;
  if (q) query.set('q', q); if (targetType) query.set('targetType', targetType);
  const data = await api(`/v1/admin/audit-logs?${query}`);
  const body = $('#auditBody'); body.replaceChildren();
  for (const log of data.items) {
    const row = element('tr');
    row.append(element('td', '', formatDate(log.createdAt)), identityCell(log.actor?.displayName, log.actor?.email));
    row.append(element('td', 'mono', log.action), element('td', 'mono', `${log.targetType}${log.targetId ? ` · ${log.targetId}` : ''}`), element('td', 'mono', JSON.stringify(log.metadata || {})));
    body.append(row);
  }
  if (!data.items.length) { const row = element('tr'); const cell = element('td', 'empty', t('noData')); cell.colSpan = 5; row.append(cell); body.append(row); }
  renderPagination($('#auditPagination'), data, 'audit');
}

async function loadCurrentView() {
  try {
    if (state.view === 'overview') await loadOverview();
    if (state.view === 'users') await loadUsers();
    if (state.view === 'conversations') await loadConversations();
    if (state.view === 'failures') await loadFailures();
    if (state.view === 'health') await loadHealth();
    if (state.view === 'tasks') await loadTasks();
    if (state.view === 'admins') await loadAdmins();
    if (state.view === 'email') await loadEmail();
    if (state.view === 'glossary') await loadGlossary();
    if (state.view === 'quality') await loadQuality();
    if (state.view === 'governance') await loadGovernance();
    if (state.view === 'settings') await loadSettings();
    if (state.view === 'audit') await loadAudit();
  } catch (error) {
    if (error.authHandled) return;
    if (error.status === 401 || error.code === 'SYSTEM_ADMIN_REQUIRED') { handleAdminAuthFailure(error); return; }
    toast(error.message, true);
  }
}

function selectView(view) {
  state.view = view;
  document.querySelectorAll('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  document.querySelectorAll('.view-panel').forEach((panel) => panel.classList.toggle('hidden', panel.id !== `view-${view}`));
  $('#pageTitle').textContent = t(view === 'conversations' ? 'meetings' : view);
  void loadCurrentView();
}

async function updateUserStatus(id, status) {
  const question = status === 'DISABLED' ? t('confirmDisable') : t('confirmEnable');
  if (!confirm(question)) return;
  await api(`/v1/admin/users/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: { status } });
  toast(t('operationDone')); await loadUsers();
}

async function revokeUser(id) {
  if (!confirm(t('confirmRevoke'))) return;
  await api(`/v1/admin/users/${encodeURIComponent(id)}/revoke-sessions`, { method: 'POST', body: {} });
  toast(t('operationDone')); await loadUsers();
}

async function resetUser(id) {
  if (!confirm(t('confirmReset'))) return;
  const data = await api(`/v1/admin/users/${encodeURIComponent(id)}/password-reset`, { method: 'POST', body: {} });
  $('#resetUrl').value = data.resetUrl;
  $('#resetDialog').showModal();
}

function detailItem(label, value) {
  const item = element('div', 'detail-item'); item.append(element('span', '', label), element('strong', '', value ?? '—')); return item;
}

async function viewMeeting(id) {
  const data = await api(`/v1/admin/conversations/${encodeURIComponent(id)}`);
  $('#dialogTitle').textContent = data.title || data.contact?.displayName || data.id;
  const content = $('#dialogContent');
  const grid = element('div', 'detail-grid');
  grid.append(
    detailItem('ID', data.id), detailItem(t('status'), data.status), detailItem(t('host'), data.owner?.displayName),
    detailItem(t('messages'), data.messageCount), detailItem(t('createdAt'), formatDate(data.createdAt)), detailItem(t('expiresAt'), formatDate(data.expiresAt)),
  );
  const heading = element('h3', '', t('participantsList'));
  const roster = element('div', 'roster');
  for (const participant of data.participants) {
    const row = element('div', 'roster-row');
    row.append(element('span', '', `${participant.displayName}${participant.company ? ` · ${participant.company}` : ''}`), element('span', '', `${participant.preferredLanguage} · ${participant.presence}`));
    roster.append(row);
  }
  const operationsHeading = element('h3', '', t('failureOverview'));
  const failures = element('div', 'roster');
  for (const failure of data.recentFailures || []) {
    const row = element('div', 'roster-row'); row.append(element('span', '', `#${failure.sequence} · ${failure.errorCode || 'UNKNOWN'}`), element('span', '', formatDate(failure.updatedAt))); failures.append(row);
  }
  if (!(data.recentFailures || []).length) failures.append(element('div', 'empty', t('noData')));
  content.replaceChildren(grid, heading, roster, operationsHeading, failures);
  $('#detailDialog').showModal();
}

async function endMeeting(id) {
  if (!confirm(t('confirmEnd'))) return;
  await api(`/v1/admin/conversations/${encodeURIComponent(id)}/end`, { method: 'POST', body: {} });
  toast(t('operationDone')); await loadConversations();
}

document.querySelectorAll('.languageSelect').forEach((select) => select.addEventListener('change', (event) => setLanguage(event.target.value)));
$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault(); $('#loginStatus').textContent = '';
  const submit = event.submitter; if (submit) submit.disabled = true;
  try {
    const response = await fetch('/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('#loginEmail').value.trim(), password: $('#loginPassword').value, deviceId: deviceId(), platform: 'UNKNOWN' }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.message || t('loginFailed'));
    sessionStorage.setItem(tokenKeys.access, result.data.accessToken);
    sessionStorage.setItem(tokenKeys.refresh, result.data.refreshToken);
    terminalAuthFailureHandled = false;
    const admin = await api('/v1/admin/me'); showConsole(admin);
  } catch (error) {
    if (!error.authHandled) {
      clearCredentials();
      $('#loginStatus').textContent = error.code === 'SYSTEM_ADMIN_REQUIRED' ? t('adminRequired') : error.message;
    }
  } finally { if (submit) submit.disabled = false; }
});

$('#logoutButton').addEventListener('click', async () => {
  const refreshToken = stored(tokenKeys.refresh);
  try { await api('/v1/auth/logout', { method: 'POST', body: { refreshToken } }, false); } catch { /* local logout remains deterministic */ }
  clearCredentials(); terminalAuthFailureHandled = true; showLogin();
});
$('#refreshButton').addEventListener('click', () => void loadCurrentView());
$('#nav').addEventListener('click', (event) => { const button = event.target.closest('[data-view]'); if (button) selectView(button.dataset.view); });
$('#userFilters').addEventListener('submit', (event) => { event.preventDefault(); state.usersPage = 1; void loadCurrentView(); });
$('#conversationFilters').addEventListener('submit', (event) => { event.preventDefault(); state.conversationsPage = 1; void loadCurrentView(); });
$('#failureFilters').addEventListener('submit', (event) => { event.preventDefault(); state.failuresPage = 1; void loadCurrentView(); });
$('#taskFilters').addEventListener('submit', (event) => { event.preventDefault(); state.tasksPage = 1; void loadCurrentView(); });
$('#auditFilters').addEventListener('submit', (event) => { event.preventDefault(); state.auditPage = 1; void loadCurrentView(); });
$('#emailFilters').addEventListener('submit', (event) => { event.preventDefault(); state.emailPage = 1; void loadCurrentView(); });
$('#glossaryFilters').addEventListener('submit', (event) => { event.preventDefault(); state.glossaryPage = 1; void loadCurrentView(); });
$('#qualityFilters').addEventListener('submit', (event) => { event.preventDefault(); state.qualityPage = 1; void loadCurrentView(); });
$('#governanceFilters').addEventListener('submit', (event) => { event.preventDefault(); state.governancePage = 1; void loadCurrentView(); });
$('#addGlossaryButton').addEventListener('click', () => void addGlossary());

document.body.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  try {
    const id = button.dataset.id; const action = button.dataset.action;
    if (action === 'disable-user') await updateUserStatus(id, 'DISABLED');
    if (action === 'enable-user') await updateUserStatus(id, 'ACTIVE');
    if (action === 'revoke-user') await revokeUser(id);
    if (action === 'reset-user') await resetUser(id);
    if (action === 'view-user') await viewUser(id);
    if (action === 'retry-failure') await retryFailure(id);
    if (action === 'retry-task') await retryTask(id);
    if (action === 'save-admin-role') await saveAdminRole(id);
    if (action === 'view-email') await viewEmail(id);
    if (action === 'disable-term') await disableTerm(id);
    if (action === 'view-quality') await viewQuality(id);
    if (action === 'decide-quality-confirm') await decideQuality(id, 'CONFIRMED');
    if (action === 'decide-quality-reject') await decideQuality(id, 'REJECTED');
    if (action === 'save-setting') await saveSetting(id);
    if (action === 'view-meeting') await viewMeeting(id);
    if (action === 'end-meeting') await endMeeting(id);
    if (action === 'users-page') { state.usersPage = Number(id); await loadUsers(); }
    if (action === 'conversations-page') { state.conversationsPage = Number(id); await loadConversations(); }
    if (action === 'failures-page') { state.failuresPage = Number(id); await loadFailures(); }
    if (action === 'tasks-page') { state.tasksPage = Number(id); await loadTasks(); }
    if (action === 'email-page') { state.emailPage = Number(id); await loadEmail(); }
    if (action === 'glossary-page') { state.glossaryPage = Number(id); await loadGlossary(); }
    if (action === 'quality-page') { state.qualityPage = Number(id); await loadQuality(); }
    if (action === 'governance-page') { state.governancePage = Number(id); await loadGovernance(); }
    if (action === 'audit-page') { state.auditPage = Number(id); await loadAudit(); }
  } catch (error) { if (!error.authHandled) toast(error.message, true); }
});

$('#copyResetUrl').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#resetUrl').value); toast(t('linkCopied')); }
  catch { $('#resetUrl').select(); document.execCommand('copy'); toast(t('linkCopied')); }
});

applyLanguage();
void authenticateConsole();
