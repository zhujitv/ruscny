const translations = {
  zh: {
    skip: '跳到主要内容', brandTag: '中俄实时翻译', menu: '打开菜单', language: '界面语言',
    previewEyebrow: '官网前台预发布', unavailableTitle: '账号与会议服务正在准备中', unavailableLead: '官网已经开放浏览。注册、登录和浏览器参会将在正式服务端完成部署后开放。', backHome: '返回官网',
    navFeatures: '核心功能', navMeeting: '多人会议', navWorkflow: '使用方式', navSecurity: '安全与记录', navDownload: '下载', navAccount: '账号', accountAction: '注册 / 登录', registerAccount: '免费注册', joinMeeting: '加入会议',
    heroEyebrow: '为中俄商务交流而设计', heroTitle: '语言不同，\n会议依然清楚。', heroLead: '把中文和俄语参会者带进同一间会议。按住说话即可完成识别、翻译与语音播放；发言人、原文、译文和时间自动同步，会后还能检索、导出并生成会议纪要。',
    heroValue1Title: '多人同会', heroValue1Text: '每位参会者都有独立身份', heroValue2Title: '双向语音', heroValue2Text: '🇨🇳 中文与 🇷🇺 俄语即时互译播放', heroValue3Title: '会后可追溯', heroValue3Text: '完整记录、导出与会议纪要',
    getApp: '获取应用', browserJoin: '浏览器直接参会', trustOne: '🇨🇳 中文 ⇄ 🇷🇺 俄语', trustTwo: '注册与临时参会', trustThree: '会议级权限隔离',
    demoTitle: '项目沟通会', live: '实时', participants: '参会者 · 5', demoChineseTeam: '中方项目组 · 🇨🇳 中文', demoRussianTeam: '俄方项目组 · 🇷🇺 Русский', companyZh: '中方采购组 · 🇨🇳 中文', companyZh2: '中方技术组 · 🇨🇳 中文', demoChineseTeamShort: '中方项目组', demoRussianTeamShort: '俄方项目组', bridgeChineseAttribution: '王伟 · 中方项目组', bridgeRussianAttribution: 'Ван Вэй · 中方项目组', speakingNow: '王伟正在发言', demoZh: '这批设备计划下周发往莫斯科。', demoCn: '请确认装箱单。', holdTalk: '按住说话', releaseSend: '松开后提交翻译', floatingIdentity: '每段内容\n保留发言归属', floatingReconnect: '断线重连\n自动补齐消息',
    builtFor: '适用于', proofTrade: '中俄贸易洽谈', proofFactory: '工厂与客户沟通', proofRemote: '远程项目会议', proofVisit: '商务考察与接待',
    filmEyebrow: '一分钟了解 RUSCNY', filmTitle: '看见一次完整的\n中俄沟通如何发生。', filmLead: '从进入会议、实时互译到会后纪要，用一段短片了解 RUSCNY 如何帮助中俄团队把每次沟通说清楚、记完整。', filmVersion: '中文版宣传片 · 约 1 分钟', filmLoadHint: '进入此区域后才准备视频；点击播放时开始传输。', filmAria: '播放 RUSCNY 中文版宣传片',
    featuresEyebrow: '不仅是翻译，更是完整的会议协作', featuresTitle: '从开口到会后记录，\n每一步都有清楚的上下文。', featuresLead: '为真实的跨国团队沟通设计，不用猜“这句话是谁说的”，也不用在多个设备之间手工整理记录。',
    featureMeetingTitle: '多人实时翻译会议', featureMeetingText: '一名主持人和多名注册或临时参会者同时进入。每个人使用自己的手机发言和查看翻译。',
    featureIdentityTitle: '明确的发言者身份', featureIdentityText: '姓名、公司、语言和发言时间与每条消息永久绑定，改名后也不会影响旧记录。',
    featureVoiceTitle: '按住说话，松开翻译', featureVoiceText: '保留自然直观的操作方式，完成识别、翻译和译文语音播放。',
    featureInviteTitle: '多种邀请方式', featureInviteText: '好友邀请、二维码、邀请链接和房间码同时保留，临时用户无需安装也能从浏览器加入。',
    featureRecordTitle: '记录、导出与 AI 会议纪要', featureRecordText: '按时间或发言者查看完整内容，导出 TXT、Markdown；会议结束后由 AI 整理主要内容，经主持人确认再分发。',
    accountSyncEyebrow: '一个账号，多个设备', accountSyncTitle: '个人资料和使用偏好，登录后保持一致。', accountSyncText: '邮箱认证保护正式账号；头像、主要语言、界面语言、自动播放和播放速度保存在账号中。网页和手机端都能查看登录设备并远程下线。', accountSyncItem1: '邮箱激活与密码找回', accountSyncItem2: '头像和播放偏好跨设备同步', accountSyncItem3: '登录设备查看与远程下线', accountSyncCta: '管理个人账号',
    minutesEyebrow: 'AI 会后整理与分发', minutesTitle: 'AI 整理会议要点，\n确认后再逐人分发。', minutesLead: '会议结束后，AI 根据本场中俄双语记录生成结构化草稿。主持人先核对当前版本，再选择参会者逐人发送，让共识、责任和下一步真正落地。',
    minutesSourceTitle: '结论有发言依据', minutesSourceText: '概要、各方观点与关键讨论保留发言人、时间、原文和译文线索，方便回到会议记录核对。',
    minutesApprovalTitle: '主持人确认当前版本', minutesApprovalText: 'AI 先生成草稿；如果会议记录更新，旧确认自动失效，重新整理并确认后才能分发。',
    minutesDeliveryTitle: '按参会者逐人发送', minutesDeliveryText: '主持人选择有可用邮箱的参会者，系统逐人发送双语纪要，不通过群发抄送公开他人地址。',
    minutesCta: '注册并开始会议', minutesDemoLabel: '项目交付会 · AI 纪要', minutesDemoStatus: '主持人已确认', minutesDemoOverview: '会议概要', minutesDemoOverviewText: '双方确认交货时间与验收流程', minutesDemoAction: '待办与负责人', minutesDemoActionText: 'Иван · 明日提交最终规格书', minutesDemoDelivery: '纪要分发', minutesDemoDeliveryText: '已选择 4 位参会者',
    meetingEyebrow: '一个房间，多方参与', meetingTitle: '多人同时参会，\n发言翻译清楚有序。', meetingLead: '每位参会者拥有独立身份和语言。主持人随时查看在线状态、邀请好友或移出人员；会议结束后立即转为只读。',
    meetingCheck1: '注册用户与临时用户同时参会', meetingCheck2: '在线、离线、离开和移出状态清晰', meetingCheck3: '断线重连后顺序与身份不丢失', instantTranslation: '即时翻译',
    workflowEyebrow: '三步开始沟通', workflowTitle: '不改变说话习惯，减少沟通成本。', step1Title: '创建或加入会议', step1Text: '通过好友邀请、二维码、链接或房间码进入。', hold: '按住', step2Title: '按住说话', step2Text: '选择中文或俄语，松开后自动提交翻译。', step3Title: '同步查看与保存', step3Text: '所有设备实时显示，会后继续查看和导出。',
    securityEyebrow: '权限由服务端决定', securityTitle: '会议内容只属于\n真正参与的人。', securityLead: '客户端不能自行伪造身份或权限。所有消息、人员、历史、导出和纪要均按单次会议隔离。', privacyLink: '了解隐私与数据处理',
    securityIdentity: '稳定参会身份', securityIdentityText: '每位参会者拥有独立 participantId。', securityIsolation: '会议数据隔离', securityIsolationText: '不同会议和企业的数据互不混合。', securityRevoke: '权限立即撤销', securityRevokeText: '移出或结束后立即停止访问与发言。', securityReliable: '可靠同步', securityReliableText: '消息排序、去重、补拉和幂等提交。',
    downloadEyebrow: '随时开始中俄沟通', downloadTitle: '在手机上使用完整功能，\n或从浏览器快速参会。', downloadLead: 'Android 与 iOS 正式版本将在应用商店开放。收到会议邀请的临时用户现在可以直接使用浏览器参会。', comingSoon: '即将开放', noInstall: '无需安装', webMeeting: '浏览器参会',
    finalEyebrow: 'RUSCNY 中俄实时翻译', finalTitle: '让跨语言会议，\n从听懂走向真正理解。', joinNow: '立即加入会议', footerText: '面向中俄商务沟通的多人实时语音翻译应用。', product: '产品', participate: '参会', browserJoinShort: '浏览器参会', roomCodeJoin: '使用房间码', legal: '规则与隐私', privacyPolicy: '隐私政策', terms: '用户协议', footerStatus: '正式运营主体与客服信息将在上线前公示',
    accountBack: '返回官网', accountEyebrow: 'RUSCNY 正式账号', accountTitle: '先建立可信身份，\n再开始每一次会议。', accountLead: '注册资料由服务端保存，用于好友邀请、多人会议身份和带发言者归属的会议记录。注册成功后，可使用同一邮箱和密码登录 App。',
    accountBenefit1Title: '创建或加入会议', accountBenefit1Text: '所有注册用户均可发起会议，也可以接受邀请加入会议。', accountBenefit2Title: '身份跟随每段发言', accountBenefit2Text: '显示名称、公司和语言与实际账号关联。', accountBenefit3Title: '中俄双语使用', accountBenefit3Text: '网页默认跟随系统语言，也可随时切换。', accountBoundary: '网页支持注册、登录和完整个人账号设置；语音会议、好友与历史记录继续在手机 App 中使用。',
    authRegisterTab: '注册', authLoginTab: '登录', registrationTitle: '创建正式账号', registrationText: '填写资料后，我们会发送激活邮件。完成邮箱认证后即可登录。', loginTitle: '欢迎回来', loginText: '使用与手机 App 相同的账号登录。', displayNameLabel: '姓名或显示名称 *', companyLabel: '所属公司（选填）', languagePreference: '主要使用语言 *', emailLabel: '邮箱 *', passwordLabel: '密码 *', passwordHelp: '至少 8 位，最多 128 位。', confirmPasswordLabel: '再次输入密码 *', consentBefore: '我已阅读并同意', consentAnd: '和', submitRegister: '注册并发送激活邮件', submitLogin: '登录', haveAccount: '已经有账号？', signInNow: '直接登录', noAccount: '还没有账号？', createNow: '立即注册', forgotPassword: '忘记密码？', verificationPendingTitle: '请查收激活邮件', verificationPendingText: '账号尚未启用。打开邮件中的一次性链接完成认证后，再返回登录。', resendVerification: '重新发送激活邮件', backToLogin: '返回登录', forgotPasswordTitle: '通过邮件重置密码', forgotPasswordText: '输入已认证邮箱。如果账号可用，我们会发送一次性密码重置链接。', sendResetEmail: '发送重置邮件', verifyingEmailTitle: '正在认证邮箱', verifyingEmailText: '正在安全验证一次性激活链接，请稍候。', resetPasswordTitle: '设置新密码', resetPasswordText: '新密码设置后，所有设备都会退出登录，需要重新认证。', confirmResetPassword: '确认重置密码',
    sessionTitle: '个人账号设置', sessionLead: '管理资料、头像、个人偏好和登录安全。', profileName: '显示名称', profileEmail: '邮箱', profileCompany: '公司', profileLanguage: '语言', logout: '退出当前网页账号',
    settingsProfileTab: '个人资料', settingsPreferencesTab: '个人偏好', settingsSecurityTab: '密码与安全', avatarLabel: '个性化头像', settingsDisplayName: '显示名称 *', settingsCompany: '所属公司', settingsPhone: '手机号', saveProfile: '保存个人资料', interfaceLanguageLabel: '默认界面语言', followSystem: '跟随设备系统', autoPlayLabel: '自动播放最终译文', autoPlayHelp: '临时识别内容不会播放', playbackSpeedLabel: '译文播放速度', preferencesSyncHint: '这些偏好保存在账号中，登录其他设备后仍可继续使用。', savePreferences: '保存个人偏好', passwordSecurityNote: '修改成功后，除当前设备外的其他登录设备会立即下线。', currentPasswordLabel: '当前密码 *', newPasswordLabel: '新密码 *', confirmNewPasswordLabel: '再次输入新密码 *', changePassword: '修改密码', loginDevicesTitle: '登录设备', loginDevicesLead: '查看当前账号的登录设备，并让不再使用的设备立即下线。', refreshDevices: '刷新',
    legalBack: '返回官网', legalLanguage: '界面语言', privacyTitle: '隐私政策', termsTitle: '用户协议', legalDraft: '发布候选文本', legalNotice: '正式运营主体、联系方式、数据存储地域和具体保留期限将在上线前补齐，并经法律审核后生效。', updated: '更新日期：2026年7月19日',
    privacyIntroTitle: '我们如何处理信息', privacyIntro: '本应用帮助中文和俄语使用者进行多人语音翻译会议。我们只处理提供认证、翻译、同步、记录和安全保障所必要的信息。',
    privacyCollectTitle: '我们处理的信息', privacyCollect: '包括账号与身份资料、参会者姓名/公司/语言、接收会议纪要的邮箱、会议关系、最终原文和译文、发言者快照、消息顺序与状态，以及提供服务所需的设备和安全日志。临时用户资料仅用于其获邀会议。',
    privacyAudioTitle: '语音与翻译', privacyAudio: '只有在用户主动按住说话时才提交语音片段。当前版本默认不长期保存完整原始录音或临时识别结果；最终译文语音可保存在私有对象存储并通过短期授权播放。',
    privacyPurposeTitle: '使用目的', privacyPurpose: '用于登录和设备安全、创建与加入会议、中俄识别和翻译、译文语音、实时同步、历史与导出、主持人明确选择后的纪要邮件分发、断线补拉、幂等去重、安全审计和处理用户请求。纪要逐人发送，不公开其他参会者邮箱。我们不将会议内容用于广告。',
    privacyShareTitle: '服务提供方', privacyShare: '语音识别、机器翻译和语音合成可能由阿里云相关服务处理；数据库、Redis 和对象存储承载业务数据；启用纪要邮件时，Resend 处理收件邮箱、显示名称和邮件正文。正式第三方清单、地域和保留期将在上线前公示。',
    privacyRightsTitle: '您的权利', privacyRights: '在适用法律范围内，您可以访问、更正、导出或删除有权管理的数据，撤回可选权限，注销账号，并请求说明信息处理规则。身份验证用于防止冒名请求。',
    privacySecurityTitle: '安全与隔离', privacySecurity: '权限以服务端认证主体和数据库关系为准。每次会议按 conversationId 隔离；被移出、会议结束、设备撤销或历史授权到期后，访问权限立即重新校验。',
    privacyContactTitle: '联系我们', privacyContact: '隐私联系人、客服邮箱、电话、运营主体和地址将在正式发布前于本页公示。',
    termsAcceptTitle: '接受协议', termsAccept: '注册、登录、以临时用户身份加入会议或实际使用服务，表示您已阅读并同意本协议和隐私政策。代表企业使用时，您应具有相应授权。',
    termsServiceTitle: '服务内容', termsService: '服务包括中俄按住说话翻译、多人会议、注册与临时参会、好友邀请、发言者归属、译文语音、历史、导出和结构化会议纪要。服务不承诺连续同声传译、重叠发言自动分离或翻译绝对准确。',
    termsAccountTitle: '账号与会议安全', termsAccount: '请提供合法准确的信息并妥善保护密码、设备和邀请凭证。不得冒用身份、转售账号、暴力猜测房间码、绕过权限或访问未获授权的会议。',
    termsRecordingTitle: '录音告知与授权', termsRecording: '会议会提示语音识别、翻译和文字记录。用户只有主动按住说话时才提交语音。提交他人语音、商业资料或受保护内容前，应取得必要授权并遵守当地法律。',
    termsRiskTitle: '翻译结果与风险', termsRisk: '自动识别与翻译可能受口音、噪声、网络、数字和专业术语影响。合同、报价、付款、技术规格、医疗、法律和安全事项必须由具备能力的人员复核。',
    termsConductTitle: '使用规范', termsConduct: '不得上传违法、侵权、欺诈或无权处理的内容，不得攻击、扫描、干扰服务或把自动翻译伪称为人工认证翻译。违规行为可能导致限速、暂停或终止服务。',
    termsAvailabilityTitle: '服务可用性', termsAvailability: '移动网络、云服务、供应商模型、维护或不可抗力可能造成延迟或中断。我们会在不降低安全和隔离要求的前提下维护和更新服务。',
    termsFeesTitle: '费用与联系', termsFees: '正式收费方案、免费额度、企业授权、退款规则、适用法律、争议解决和客服信息将在上线前明确展示；在获得确认前不会依据本候选文本自动收费。'
  },
  ru: {
    skip: 'Перейти к содержанию', brandTag: 'Перевод между китайским и русским', menu: 'Открыть меню', language: 'Язык интерфейса',
    previewEyebrow: 'Предварительный запуск сайта', unavailableTitle: 'Сервис аккаунтов и встреч готовится', unavailableLead: 'Информационный сайт уже доступен. Регистрация, вход и участие через браузер откроются после запуска сервера.', backHome: 'Вернуться на сайт',
    navFeatures: 'Возможности', navMeeting: 'Групповые встречи', navWorkflow: 'Как это работает', navSecurity: 'Безопасность', navDownload: 'Скачать', navAccount: 'Аккаунт', accountAction: 'Регистрация / вход', registerAccount: 'Регистрация', joinMeeting: 'Войти во встречу',
    heroEyebrow: 'Создано для российско-китайского бизнеса', heroTitle: 'Разные языки.\nПонятная встреча.', heroLead: 'Соберите китайских и русскоязычных участников в одной встрече. Удерживайте кнопку для распознавания, перевода и озвучивания; автор, оригинал, перевод и время синхронизируются автоматически, а после встречи доступны поиск, экспорт и протокол.',
    heroValue1Title: 'Общая встреча', heroValue1Text: 'У каждого участника своя личность', heroValue2Title: 'Двусторонняя речь', heroValue2Text: 'Перевод и озвучивание 🇨🇳 中文 ⇄ 🇷🇺 Русский', heroValue3Title: 'Всё сохраняется', heroValue3Text: 'История, экспорт и протокол встречи',
    getApp: 'Получить приложение', browserJoin: 'Войти через браузер', trustOne: '🇨🇳 中文 ⇄ 🇷🇺 Русский', trustTwo: 'Аккаунты и гости', trustThree: 'Изоляция каждой встречи',
    demoTitle: 'Рабочая встреча', live: 'В эфире', participants: 'Участники · 5', demoChineseTeam: 'Китайская команда · 🇨🇳 中文', demoRussianTeam: 'Российская команда · 🇷🇺 Русский', companyZh: 'Закупки Китая · 🇨🇳 中文', companyZh2: 'Техническая группа Китая · 🇨🇳 中文', demoChineseTeamShort: 'Китайская команда', demoRussianTeamShort: 'Российская команда', bridgeChineseAttribution: 'Ван Вэй · Китайская команда', bridgeRussianAttribution: 'Ван Вэй · Китайская команда', speakingNow: 'Сейчас говорит Ван Вэй', demoZh: 'Эту партию оборудования планируется отправить в Москву на следующей неделе.', demoCn: '请确认装箱单。', holdTalk: 'Удерживайте для речи', releaseSend: 'Отпустите для перевода', floatingIdentity: 'Каждая реплика\nсохранена с автором', floatingReconnect: 'Переподключение\nвосстановит сообщения',
    builtFor: 'Для задач', proofTrade: 'Торговые переговоры', proofFactory: 'Завод и заказчик', proofRemote: 'Удалённые проекты', proofVisit: 'Деловые визиты',
    filmEyebrow: 'RUSCNY за одну минуту', filmTitle: 'Посмотрите, как проходит\nвстреча на двух языках.', filmLead: 'Короткий фильм показывает весь путь: вход во встречу, перевод в реальном времени и итоговый протокол для китайско-российской команды.', filmVersion: 'Русская версия · около 1 минуты', filmLoadHint: 'Видео подготавливается только при появлении этого блока; передача начинается после нажатия «Воспроизвести».', filmAria: 'Воспроизвести презентационный фильм RUSCNY на русском языке',
    featuresEyebrow: 'Не только перевод, а полноценная совместная работа', featuresTitle: 'От первой реплики до протокола —\nвсё сохраняет контекст.', featuresLead: 'Создано для реальной международной команды: не нужно угадывать автора реплики или вручную собирать записи с разных устройств.',
    featureMeetingTitle: 'Групповой перевод в реальном времени', featureMeetingText: 'Один организатор и несколько зарегистрированных или временных участников. Каждый говорит и видит перевод на своём телефоне.',
    featureIdentityTitle: 'Точный автор каждой реплики', featureIdentityText: 'Имя, компания, язык и время навсегда связаны с сообщением. Изменение профиля не меняет историю.',
    featureVoiceTitle: 'Нажмите, говорите, отпустите', featureVoiceText: 'Привычное управление запускает распознавание, перевод и озвучивание результата.',
    featureInviteTitle: 'Удобные приглашения', featureInviteText: 'Друзья, QR-код, ссылка и код комнаты. Гость может присоединиться через браузер без установки.',
    featureRecordTitle: 'История, экспорт и AI-протокол', featureRecordText: 'Просматривайте историю по времени или участнику, экспортируйте TXT и Markdown. После встречи AI подготовит основные итоги, а организатор подтвердит их перед отправкой.',
    accountSyncEyebrow: 'Один аккаунт на всех устройствах', accountSyncTitle: 'Профиль и личные настройки всегда остаются с вами.', accountSyncText: 'Подтверждение email защищает аккаунт. Аватар, основной язык, язык интерфейса, автовоспроизведение и скорость речи сохраняются в аккаунте. Устройства можно просматривать и удалённо отключать на сайте и в приложении.', accountSyncItem1: 'Активация email и восстановление пароля', accountSyncItem2: 'Синхронизация аватара и настроек звука', accountSyncItem3: 'Просмотр и удалённое отключение устройств', accountSyncCta: 'Настроить аккаунт',
    minutesEyebrow: 'AI-обработка и отправка после встречи', minutesTitle: 'AI подводит итоги встречи.\nОрганизатор проверяет и отправляет.', minutesLead: 'После завершения AI формирует структурированный черновик по китайским и русским репликам. Организатор проверяет текущую версию, выбирает участников и отправляет каждому отдельное письмо с договорённостями, ответственными и следующими шагами.',
    minutesSourceTitle: 'Выводы связаны с репликами', minutesSourceText: 'Обзор, позиции сторон и ключевые обсуждения сохраняют данные об авторе, времени, оригинале и переводе — всегда можно вернуться к записи.',
    minutesApprovalTitle: 'Подтверждает организатор', minutesApprovalText: 'Сначала AI создаёт черновик. Если запись встречи изменилась, прежнее подтверждение отменяется: нужно обновить и проверить новую версию.',
    minutesDeliveryTitle: 'Отдельное письмо каждому', minutesDeliveryText: 'Организатор выбирает участников с доступным email. Письма отправляются отдельно, без раскрытия адресов других получателей.',
    minutesCta: 'Зарегистрироваться и начать', minutesDemoLabel: 'Встреча по поставке · AI-протокол', minutesDemoStatus: 'Подтверждено организатором', minutesDemoOverview: 'Итог встречи', minutesDemoOverviewText: 'Стороны согласовали срок поставки и приёмку', minutesDemoAction: 'Задача и ответственный', minutesDemoActionText: 'Иван · завтра отправить спецификацию', minutesDemoDelivery: 'Отправка протокола', minutesDemoDeliveryText: 'Выбрано 4 участника',
    meetingEyebrow: 'Одна комната, несколько сторон', meetingTitle: 'Несколько участников, два языка —\nкаждая реплика понятна и на своём месте.', meetingLead: 'У каждого свой профиль и язык. Организатор видит статусы, приглашает друзей или удаляет участника. После завершения встреча сразу становится доступной только для чтения.',
    meetingCheck1: 'Аккаунты и временные гости вместе', meetingCheck2: 'Понятные статусы присутствия', meetingCheck3: 'Порядок и авторство сохраняются после обрыва', instantTranslation: 'Мгновенный перевод',
    workflowEyebrow: 'Начните за три шага', workflowTitle: 'Говорите как обычно. Общайтесь проще.', step1Title: 'Создайте встречу или войдите', step1Text: 'По приглашению друга, QR-коду, ссылке или коду комнаты.', hold: 'Удерживать', step2Title: 'Удерживайте и говорите', step2Text: 'Выберите китайский или русский и отпустите для перевода.', step3Title: 'Смотрите и сохраняйте', step3Text: 'Результат синхронно виден всем и остаётся в истории.',
    securityEyebrow: 'Права определяет сервер', securityTitle: 'Содержание встречи доступно\nтолько её участникам.', securityLead: 'Клиент не может подделать личность или роль. Сообщения, участники, история, экспорт и протокол изолированы в рамках одной встречи.', privacyLink: 'О конфиденциальности и данных',
    securityIdentity: 'Стабильная личность', securityIdentityText: 'У каждого участника собственный participantId.', securityIsolation: 'Изоляция данных', securityIsolationText: 'Встречи и компании не смешивают данные.', securityRevoke: 'Мгновенный отзыв доступа', securityRevokeText: 'После удаления или завершения доступ закрывается.', securityReliable: 'Надёжная синхронизация', securityReliableText: 'Порядок, дедупликация, догрузка и идемпотентность.',
    downloadEyebrow: 'Начните общение в любой момент', downloadTitle: 'Полные возможности на телефоне\nили быстрый вход через браузер.', downloadLead: 'Версии Android и iOS появятся в магазинах приложений. Получивший приглашение гость уже может войти через браузер.', comingSoon: 'Скоро', noInstall: 'Без установки', webMeeting: 'Войти в браузере',
    finalEyebrow: 'RUSCNY · перевод между китайским и русским', finalTitle: 'Не просто услышать,\nа действительно понять.', joinNow: 'Войти во встречу', footerText: 'Групповой голосовой перевод для российско-китайского делового общения.', product: 'Продукт', participate: 'Участие', browserJoinShort: 'Войти через браузер', roomCodeJoin: 'Ввести код комнаты', legal: 'Документы', privacyPolicy: 'Конфиденциальность', terms: 'Условия использования', footerStatus: 'Оператор и контакты будут опубликованы до запуска',
    accountBack: 'На главную', accountEyebrow: 'Аккаунт RUSCNY', accountTitle: 'Сначала надёжная личность —\nзатем каждая встреча.', accountLead: 'Профиль хранится на сервере и используется для приглашений друзей, личности во встрече и истории с точным авторством. После регистрации войдите в приложение с теми же email и паролем.',
    accountBenefit1Title: 'Создавайте встречи или участвуйте', accountBenefit1Text: 'Любой зарегистрированный пользователь может создать встречу или присоединиться по приглашению.', accountBenefit2Title: 'Личность у каждой реплики', accountBenefit2Text: 'Имя, компания и язык связаны с реальным аккаунтом.', accountBenefit3Title: 'Интерфейс на двух языках', accountBenefit3Text: 'Язык следует системе, но его всегда можно изменить.', accountBoundary: 'На сайте доступны регистрация, вход и полные настройки аккаунта. Голосовые встречи, друзья и полная история работают в мобильном приложении.',
    authRegisterTab: 'Регистрация', authLoginTab: 'Вход', registrationTitle: 'Создать аккаунт', registrationText: 'После регистрации мы отправим письмо. Подтвердите email, чтобы войти.', loginTitle: 'С возвращением', loginText: 'Используйте тот же аккаунт, что и в мобильном приложении.', displayNameLabel: 'Имя или отображаемое имя *', companyLabel: 'Компания (необязательно)', languagePreference: 'Основной язык *', emailLabel: 'Email *', passwordLabel: 'Пароль *', passwordHelp: 'От 8 до 128 символов.', confirmPasswordLabel: 'Повторите пароль *', consentBefore: 'Я прочитал(а) и принимаю', consentAnd: 'и', submitRegister: 'Регистрация и письмо активации', submitLogin: 'Войти', haveAccount: 'Уже есть аккаунт?', signInNow: 'Войти', noAccount: 'Нет аккаунта?', createNow: 'Зарегистрироваться', forgotPassword: 'Забыли пароль?', verificationPendingTitle: 'Проверьте почту', verificationPendingText: 'Аккаунт ещё не активирован. Откройте одноразовую ссылку из письма, затем войдите.', resendVerification: 'Отправить письмо повторно', backToLogin: 'Вернуться ко входу', forgotPasswordTitle: 'Сброс пароля по email', forgotPasswordText: 'Введите подтверждённый email. Если аккаунт доступен, мы отправим одноразовую ссылку.', sendResetEmail: 'Отправить ссылку', verifyingEmailTitle: 'Подтверждаем email', verifyingEmailText: 'Безопасно проверяем одноразовую ссылку. Подождите.', resetPasswordTitle: 'Новый пароль', resetPasswordText: 'После смены пароля все устройства выйдут из аккаунта.', confirmResetPassword: 'Сбросить пароль',
    sessionTitle: 'Настройки аккаунта', sessionLead: 'Управляйте профилем, аватаром, личными предпочтениями и безопасностью.', profileName: 'Отображаемое имя', profileEmail: 'Email', profileCompany: 'Компания', profileLanguage: 'Язык', logout: 'Выйти на этом сайте',
    settingsProfileTab: 'Профиль', settingsPreferencesTab: 'Предпочтения', settingsSecurityTab: 'Пароль и безопасность', avatarLabel: 'Персональный аватар', settingsDisplayName: 'Отображаемое имя *', settingsCompany: 'Компания', settingsPhone: 'Телефон', saveProfile: 'Сохранить профиль', interfaceLanguageLabel: 'Язык интерфейса по умолчанию', followSystem: 'Как в системе устройства', autoPlayLabel: 'Автовоспроизведение финального перевода', autoPlayHelp: 'Промежуточное распознавание не воспроизводится', playbackSpeedLabel: 'Скорость озвучивания перевода', preferencesSyncHint: 'Эти настройки сохраняются в аккаунте и доступны после входа на другом устройстве.', savePreferences: 'Сохранить предпочтения', passwordSecurityNote: 'После смены пароля все устройства, кроме текущего, будут немедленно отключены.', currentPasswordLabel: 'Текущий пароль *', newPasswordLabel: 'Новый пароль *', confirmNewPasswordLabel: 'Повторите новый пароль *', changePassword: 'Изменить пароль', loginDevicesTitle: 'Устройства входа', loginDevicesLead: 'Просматривайте устройства аккаунта и отключайте те, которыми больше не пользуетесь.', refreshDevices: 'Обновить',
    legalBack: 'На главную', legalLanguage: 'Язык интерфейса', privacyTitle: 'Политика конфиденциальности', termsTitle: 'Условия использования', legalDraft: 'Текст-кандидат к публикации', legalNotice: 'Юридическое лицо оператора, контакты, регион хранения и точные сроки будут добавлены и юридически проверены до запуска.', updated: 'Обновлено: 19 июля 2026 г.',
    privacyIntroTitle: 'Как мы обрабатываем данные', privacyIntro: 'Приложение помогает русско- и китайскоязычным пользователям проводить групповые встречи с голосовым переводом. Мы обрабатываем только данные, необходимые для аутентификации, перевода, синхронизации, истории и безопасности.',
    privacyCollectTitle: 'Какие данные обрабатываются', privacyCollect: 'Данные аккаунта и профиля, имя/компания/язык участника, email для получения протокола, связи со встречей, финальный оригинал и перевод, снимок автора, порядок и статус сообщений, а также технические журналы безопасности. Данные гостя относятся только к приглашённой встрече.',
    privacyAudioTitle: 'Речь и перевод', privacyAudio: 'Аудиофрагмент отправляется только при активном удержании кнопки речи. Полные исходные записи и промежуточные результаты по умолчанию не хранятся длительно. Озвученный перевод может храниться в закрытом объектном хранилище с краткосрочным доступом.',
    privacyPurposeTitle: 'Цели обработки', privacyPurpose: 'Вход и безопасность устройства, встречи, распознавание и перевод, озвучивание, синхронизация, история и экспорт, отправка протокола по явному выбору организатора, восстановление после обрыва, дедупликация, аудит и запросы пользователей. Письма отправляются отдельно, адреса других участников не раскрываются. Содержание встреч не используется для рекламы.',
    privacyShareTitle: 'Поставщики услуг', privacyShare: 'Распознавание, перевод и синтез речи могут выполняться сервисами Alibaba Cloud. Базы данных, Redis и объектное хранилище обеспечивают работу продукта. При отправке протокола Resend обрабатывает email получателя, отображаемое имя и текст письма. Полный список, регионы и сроки хранения будут опубликованы до запуска.',
    privacyRightsTitle: 'Ваши права', privacyRights: 'В пределах применимого права вы можете получить, исправить, экспортировать или удалить управляемые данные, отозвать необязательные разрешения, удалить аккаунт и запросить объяснение обработки.',
    privacySecurityTitle: 'Безопасность и изоляция', privacySecurity: 'Доступ определяется серверной личностью и отношениями в базе данных. Каждая встреча изолирована по conversationId. После удаления, завершения, отзыва устройства или окончания срока права проверяются заново.',
    privacyContactTitle: 'Контакты', privacyContact: 'Оператор, адрес, телефон, служба поддержки и контакт по вопросам конфиденциальности будут опубликованы на этой странице до официального запуска.',
    termsAcceptTitle: 'Принятие условий', termsAccept: 'Регистрация, вход, участие как гость или использование сервиса означает принятие этих условий и политики конфиденциальности. Используя сервис от имени компании, вы подтверждаете свои полномочия.',
    termsServiceTitle: 'Содержание сервиса', termsService: 'Сервис включает перевод по нажатию, групповые встречи, аккаунты и гостей, приглашения, авторство реплик, озвучивание, историю, экспорт и протокол. Не гарантируются непрерывный синхронный перевод, автоматическое разделение одновременной речи или абсолютная точность.',
    termsAccountTitle: 'Безопасность аккаунта и встречи', termsAccount: 'Указывайте законные данные и защищайте пароль, устройство и приглашения. Запрещены подмена личности, продажа аккаунтов, подбор кода комнаты, обход прав и доступ к чужим встречам.',
    termsRecordingTitle: 'Уведомление о речи и согласие', termsRecording: 'Перед встречей сообщается о распознавании, переводе и сохранении текста. Аудио отправляется только при активном нажатии. Перед отправкой чужой речи или защищённых материалов получите необходимые разрешения.',
    termsRiskTitle: 'Риски перевода', termsRisk: 'На результат влияют акцент, шум, сеть, числа и терминология. Договоры, цены, платежи, технические параметры, медицинские, юридические и безопасностные решения должны проверяться компетентным специалистом.',
    termsConductTitle: 'Правила поведения', termsConduct: 'Запрещены незаконные, нарушающие права или неразрешённые материалы, атаки, сканирование, вмешательство в сервис и выдача автоматического перевода за заверенный человеческий. Нарушения могут привести к ограничению или блокировке.',
    termsAvailabilityTitle: 'Доступность сервиса', termsAvailability: 'Мобильная сеть, облачные сервисы, модели поставщиков, обслуживание и форс-мажор могут вызвать задержки или перерывы. Сервис обновляется без снижения требований безопасности и изоляции.',
    termsFeesTitle: 'Стоимость и контакты', termsFees: 'Тарифы, бесплатные лимиты, корпоративные лицензии, возвраты, применимое право, разрешение споров и контакты будут ясно опубликованы до запуска. Этот кандидат текста сам по себе не создаёт платёжных обязательств.'
  }
};

const localeKey = 'ruscny.locale';
const normalizeLocale = (value) => value === 'ru' ? 'ru' : 'zh';
const initialLocale = (() => {
  try {
    const stored = localStorage.getItem(localeKey);
    if (stored) return normalizeLocale(stored);
  } catch (_) { /* Storage may be unavailable in private contexts. */ }
  return navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'zh';
})();

const promoFilm = document.querySelector('.promo-film-video');
let promoFilmVisible = false;

function updatePromoFilm(locale) {
  if (!promoFilm) return;
  const selected = normalizeLocale(locale);
  const nextSource = selected === 'ru' ? promoFilm.dataset.srcRu : promoFilm.dataset.srcZh;
  promoFilm.setAttribute('aria-label', translations[selected].filmAria);
  if (!promoFilmVisible || !nextSource || promoFilm.getAttribute('src') === nextSource) return;
  promoFilm.pause();
  promoFilm.setAttribute('src', nextSource);
  promoFilm.load();
}

function applyLocale(locale) {
  const selected = normalizeLocale(locale);
  const dictionary = translations[selected];
  document.documentElement.lang = selected === 'ru' ? 'ru' : 'zh-CN';
  document.querySelectorAll('[data-i18n]').forEach((element) => {
    const key = element.dataset.i18n;
    if (!key || dictionary[key] === undefined) return;
    element.textContent = dictionary[key];
    element.style.whiteSpace = dictionary[key].includes('\n') ? 'pre-line' : '';
  });
  document.querySelectorAll('.locale-select').forEach((select) => { select.value = selected; });
  updatePromoFilm(selected);
  if (document.body.dataset.page === 'privacy') document.title = `${dictionary.privacyTitle}｜RUSCNY`;
  else if (document.body.dataset.page === 'terms') document.title = `${dictionary.termsTitle}｜RUSCNY`;
  else if (document.body.dataset.page === 'account') document.title = `${dictionary.accountAction}｜RUSCNY`;
  else document.title = selected === 'ru' ? 'Голосовой перевод китайский ⇄ русский｜RUSCNY' : '中俄实时语音翻译｜RUSCNY';
  try { localStorage.setItem(localeKey, selected); } catch (_) { /* Nonessential preference. */ }
}

document.querySelectorAll('.locale-select').forEach((select) => {
  select.addEventListener('change', (event) => applyLocale(event.target.value));
});

const menuButton = document.querySelector('.menu-toggle');
const menu = document.querySelector('.main-nav');
if (menuButton && menu) {
  menuButton.addEventListener('click', () => {
    const open = !menu.classList.contains('open');
    menu.classList.toggle('open', open);
    menuButton.setAttribute('aria-expanded', String(open));
  });
  menu.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
    menu.classList.remove('open');
    menuButton.setAttribute('aria-expanded', 'false');
  }));
}

const year = document.querySelector('#year');
if (year) year.textContent = String(new Date().getFullYear());

if (promoFilm) {
  if ('IntersectionObserver' in globalThis) {
    const filmObserver = new IntersectionObserver((entries, observer) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      promoFilmVisible = true;
      updatePromoFilm(document.documentElement.lang === 'ru' ? 'ru' : 'zh');
      observer.disconnect();
    }, { rootMargin: '240px 0px' });
    filmObserver.observe(promoFilm);
  } else {
    promoFilmVisible = true;
  }
}
applyLocale(initialLocale);
