// ============================================================
// "创智算"技术方向数据库（单一数据源）
// ------------------------------------------------------------
// 首页"协会覆盖的技术方向"卡片与方向详情页（fields.html?id=xxx）均由本文件渲染。
//
// 字段说明：
//   id         唯一标识（fields.html?id=xxx）
//   name       方向名称
//   icon       编号（如 IC / R / U）
//   tag        首页卡片上的标签（如 IC · 01）
//   desc       一句话描述
//   status     active 已开放 | soon 规划中
//   motto      科技感标语（详情页 hero）
//   techStack  技术栈数组
//   resources  学习资源数组
//     { title, type, desc, url }
//     type: 入门课程 / 官方文档 / 进阶路线 / 网盘资源 / 实践项目
//     url 为空表示待补充（协会飞书文档资源整理中）
//   competitions 关联竞赛 id（对应 js/competitions-data.js）
// ============================================================
window.FIELDS = [
  {
    id: 'software',
    name: '软件开发',
    icon: 'R',
    tag: 'R · 02',
    desc: '算法竞赛、Web / 后端开发实践',
    status: 'active',
    motto: 'WRITE CODE, SOLVE PROBLEMS.',
    techStack: ['C / C++', 'Python', 'Java', '数据结构与算法', 'Web 开发（HTML/CSS/JS）', '数据库（MySQL/Redis）', 'Linux 与 Git', '大模型应用开发'],
    resourceKeywords: ['java', 'python', 'c++', 'c/c++', 'go', '前端', 'vue', 'react', 'web', '算法', '数据结构', '数据库', 'linux', 'git', '小程序', 'flutter', 'node', 'javascript', 'css', 'html', 'mysql', 'redis', 'docker', 'spring', '微服务', '分布式', '后端', '编译', '程序设计', '逆向'],
    resources: [
      { title: '数据结构与算法（C++ 版）', type: '入门课程', desc: '邓俊辉 · 清华大学学堂在线，算法竞赛入门的经典课程。', url: 'https://www.xuetangx.com/course/THU08091000384/19324399' },
      { title: 'Python 官方教程', type: '官方文档', desc: 'Python 官方中文教程，从零到进阶的权威资料。', url: 'https://docs.python.org/zh-cn/3/tutorial/' },
      { title: 'MDN Web 开发文档', type: '官方文档', desc: 'HTML / CSS / JavaScript 最权威的参考手册。', url: 'https://developer.mozilla.org/zh-CN/' },
      { title: 'LeetCode 刷题平台', type: '进阶路线', desc: '算法题海 + 周赛，蓝桥杯 / CCPC / ICPC 备赛主战场。', url: 'https://leetcode.cn/' },
      { title: 'Git 官方教程', type: '官方文档', desc: '版本控制入门到协作工作流，工程实践必备技能。', url: 'https://git-scm.com/book/zh/v2' },
      { title: '协会课程资源合集（网盘）', type: '网盘资源', desc: '编程语言、算法竞赛、Web 开发等视频与课件资源整理中。', url: '' },
    ],
    competitions: ['icpc', 'ccpc', 'lanqiao', 'ccd', 'iscc'],
  },
  {
    id: 'embedded',
    name: '嵌入式开发',
    icon: 'U',
    tag: 'U · 03',
    desc: '单片机、驱动开发、硬件调试',
    status: 'active',
    motto: 'CODE MEETS SILICON.',
    techStack: ['C 语言', 'STM32 单片机', 'Arduino / ESP32', 'RTOS 实时操作系统', '电路基础与原理图', 'PCB 设计（立创 EDA）', '传感器与驱动开发', 'FPGA 入门'],
    resourceKeywords: ['内核', '驱动', '汇编', '嵌入式', '单片机', 'stm32', '硬件', 'fpga', '树莓派', 'arduino', '底层', 'arm', 'rtos', '电路'],
    resources: [
      { title: 'C 语言程序设计', type: '入门课程', desc: '翁恺 · 浙江大学，嵌入式开发最基础的 C 语言课程。', url: 'https://www.icourse163.org/course/ZJU-9001' },
      { title: 'STM32 官方资料站', type: '官方文档', desc: '意法半导体官方文档、HAL 库与参考手册。', url: 'https://www.st.com.cn/zh/microcontrollers-microprocessors/stm32-32-bit-arm-cortex-mcus.html' },
      { title: '立创开源硬件平台', type: '实践项目', desc: '海量开源电路与 PCB 工程，硬件入门的灵感库。', url: 'https://oshwhub.com/' },
      { title: 'FreeRTOS 官方文档', type: '官方文档', desc: '轻量级实时操作系统，电赛与工控项目常用。', url: 'https://www.freertos.org/zh-cn-cmn-s/' },
      { title: '嘉立创 EDA 教程', type: '进阶路线', desc: '从原理图到打样，PCB 设计全流程实战。', url: 'https://prodocs.lceda.cn/cn/' },
      { title: '协会课程资源合集（网盘）', type: '网盘资源', desc: '电赛真题、开发板例程、硬件调试经验资源整理中。', url: '' },
    ],
    competitions: ['nuedc', 'ti-prov', 'smartcar', 'soc'],
  },
  {
    id: 'iot',
    name: '物联网开发',
    icon: 'M',
    tag: 'M · 04',
    desc: '传感网络、边缘计算、智能硬件',
    status: 'active',
    motto: 'EVERYTHING, CONNECTED.',
    techStack: ['传感器网络', 'MQTT / CoAP 协议', 'WiFi / BLE / Zigbee', 'ESP32 系列开发', '边缘计算', '云端接入（阿里云/OneNET）', '低功耗设计', '智能家居方案'],
    resourceKeywords: ['物联网', 'iot', '传感器', '智能硬件', 'esp', 'wifi', '智能家居', 'mqtt', '边缘'],
    resources: [
      { title: 'ESP-IDF 官方文档', type: '官方文档', desc: '乐鑫官方物联网开发框架，WiFi/BLE 一站搞定。', url: 'https://docs.espressif.com/projects/esp-idf/zh_CN/latest/esp32/' },
      { title: 'MQTT 协议入门', type: '入门课程', desc: 'EMQ 中文社区教程，物联网通信协议的必修课。', url: 'https://www.emqx.com/zh/blog/mqtt-essentials' },
      { title: 'OneNET 物联网开放平台', type: '实践项目', desc: '中移物联网平台，快速搭建设备上云 Demo。', url: 'https://open.iot.10086.cn/' },
      { title: 'Arduino 官方教程', type: '入门课程', desc: '零基础快速上手传感器与执行器编程。', url: 'https://www.arduino.cc/reference/zh/' },
      { title: '协会课程资源合集（网盘）', type: '网盘资源', desc: '物联网实训例程、云平台接入教程资源整理中。', url: '' },
    ],
    competitions: [],
  },
  {
    id: 'robot',
    name: '机器人开发',
    icon: 'Q',
    tag: 'Q · 05',
    desc: '机械结构、运动控制、RoboCup 方向',
    status: 'active',
    motto: 'BUILD MACHINES THAT MOVE.',
    techStack: ['ROS / ROS2', '运动学与动力学', '机械结构设计（SolidWorks）', 'SLAM 定位建图', '路径规划', '电机与伺服控制', '传感器融合', '仿真（Gazebo/Webots）'],
    resourceKeywords: ['机器人', 'ros', '自动驾驶', 'slam', '运动控制', '路径规划', '机械', '电机', '伺服'],
    resources: [
      { title: 'ROS2 官方教程', type: '官方文档', desc: '机器人操作系统权威文档，含 Humble 版本中文教程。', url: 'https://docs.ros.org/en/humble/Tutorials.html' },
      { title: '古月居 ROS 入门', type: '入门课程', desc: '国内最流行的 ROS 入门视频课与博客。', url: 'https://www.guyuehome.com/' },
      { title: 'Gazebo 仿真文档', type: '官方文档', desc: '机器人仿真环境，建模与算法验证的标配。', url: 'https://gazebosim.org/docs' },
      { title: 'RoboCup 中国委员会', type: '进阶路线', desc: '中国机器人大赛赛项规则与技术资料。', url: 'https://rcccaa.drct-caa.org.cn' },
      { title: '协会课程资源合集（网盘）', type: '网盘资源', desc: '机械结构图集、控制算法代码资源整理中。', url: '' },
    ],
    competitions: ['smartrobot', 'jsrobot', 'caa-robot'],
  },
  {
    id: 'embodied',
    name: '具身智能',
    icon: 'X',
    tag: 'X · 06',
    desc: '感知-决策-执行一体化前沿探索',
    status: 'active',
    motto: 'INTELLIGENCE, EMBODIED.',
    techStack: ['视觉感知（CV）', '多模态大模型', '强化学习', '模仿学习', '机械臂控制', '仿真（Isaac Sim / MuJoCo）', 'VLA 模型', '触觉与力控'],
    resourceKeywords: ['机器人', '自动驾驶', 'slam', '强化学习', '具身', '机械臂', '多模态', '视觉', 'vla', 'isaac', 'mujoco'],
    resources: [
      { title: '强化学习导论', type: '入门课程', desc: 'David Silver 经典课程 + 中文笔记，RL 入门口碑之作。', url: 'https://www.davidsilver.uk/teaching/' },
      { title: 'PyTorch 官方教程', type: '官方文档', desc: '深度学习框架权威教程，具身智能算法实现基础。', url: 'https://pytorch.org/tutorials/' },
      { title: 'MuJoCo 物理引擎文档', type: '官方文档', desc: '高性能仿真引擎，机械臂与灵巧手训练必备。', url: 'https://mujoco.readthedocs.io/' },
      { title: 'Hugging Face LeRobot', type: '实践项目', desc: '开源机器人学习框架，真机数据采集与策略训练。', url: 'https://huggingface.co/lerobot' },
      { title: 'Isaac Sim 文档', type: '进阶路线', desc: 'NVIDIA 机器人仿真平台，支持大规模并行训练。', url: 'https://docs.isaacsim.omniverse.nvidia.com/' },
      { title: '协会课程资源合集（网盘）', type: '网盘资源', desc: '具身智能论文精读、环境搭建镜像资源整理中。', url: '' },
    ],
    competitions: ['smartrobot', 'caa-robot'],
  },
  {
    id: 'ai',
    name: '人工智能 AI',
    icon: 'A',
    tag: 'A · 07',
    desc: '机器学习、大模型应用实践',
    status: 'active',
    motto: 'LEARN FROM DATA.',
    techStack: ['Python 与 NumPy', '机器学习基础', '深度学习（PyTorch）', '大模型微调与 RAG', 'Prompt 工程', '计算机视觉', '数据处理（Pandas）', '模型部署'],
    resourceKeywords: ['大模型', 'ai', '人工智能', '深度学习', '机器学习', 'llm', 'nlp', 'transformer', 'opencv', '计算机视觉', 'agent', '智能体', 'mcp', '提示词', 'prompt', '生成式', '图像', '数据', 'pytorch'],
    resources: [
      { title: '吴恩达机器学习', type: '入门课程', desc: '机器学习入门的全球经典课程。', url: 'https://www.coursera.org/specializations/machine-learning-introduction' },
      { title: '李宏毅机器学习', type: '入门课程', desc: '中文机器学习课程天花板，含大模型专题。', url: 'https://speech.ee.ntu.edu.tw/~hylee/ml/2023-spring.php' },
      { title: 'PyTorch 官方教程', type: '官方文档', desc: '深度学习框架权威教程。', url: 'https://pytorch.org/tutorials/' },
      { title: '动手学深度学习', type: '进阶路线', desc: '李沐 · 理论与代码结合，中文社区口碑之作。', url: 'https://zh.d2l.ai/' },
      { title: 'Hugging Face 官方课程', type: '进阶路线', desc: 'Transformer、微调与 RLHF 实战。', url: 'https://huggingface.co/learn' },
      { title: '协会课程资源合集（网盘）', type: '网盘资源', desc: 'AI 视频课程、论文合辑、模型权重资源整理中。', url: '' },
    ],
    competitions: ['caa-robot'],
  },
  {
    id: 'innov',
    name: '创新创业',
    icon: 'IC',
    tag: 'IC · 01',
    desc: '创业计划书、路演辅导、"互联网+"赛道资源',
    status: 'active',
    motto: 'FROM IDEA TO IMPACT.',
    techStack: ['商业计划书撰写', '市场调研', '路演表达与 PPT', '商业模式画布', '财务建模', '知识产权基础', '项目落地与运营'],
    resourceKeywords: ['自媒体', '运营', '短视频', '电商', '商业', '创业'],
    resources: [
      { title: '全国大学生创业服务网', type: '官方文档', desc: '"互联网+"大赛官方报名平台，含历届获奖项目资料。', url: 'https://cy.ncss.cn/' },
      { title: '商业模式新生代', type: '入门课程', desc: '商业模式画布方法论，创业类比赛通用框架。', url: 'https://www.strategyzer.com/library' },
      { title: '协会课程资源合集（网盘）', type: '网盘资源', desc: '历年获奖计划书模板、路演视频资源整理中。', url: '' },
    ],
    competitions: ['internet-plus'],
  },
  {
    id: 'baoyan',
    name: '保研',
    icon: 'S',
    tag: 'S · 08',
    desc: '夏令营时间线、经验分享、内推信息',
    status: 'soon',
    motto: '',
    techStack: [],
    resources: [],
    competitions: [],
  },
  {
    id: 'kaoyan',
    name: '考研',
    icon: 'S',
    tag: 'S · 09',
    desc: '择校择专业、真题资料、考研搭子',
    status: 'active',
    motto: 'LEVEL UP YOUR STUDIES.',
    techStack: ['择校与择专业', '政治', '英语（一/二）', '数学（一/二/三）', '专业课复习规划', '复试与调剂', '考研搭子小组'],
    resourceKeywords: ['考研', '公考', '省考', '国考', '教资', '事业单位', '公务员'],
    resources: [
      { title: '中国研究生招生信息网（研招网）', type: '官方文档', desc: '考研报名、招生目录、调剂等官方唯一入口。', url: 'https://yz.chsi.com.cn/' },
      { title: '研招网硕士专业目录', type: '官方文档', desc: '按学科/地区查询招生单位与考试科目。', url: 'https://yz.chsi.com.cn/zsml/' },
      { title: '协会考研网盘资源', type: '网盘资源', desc: '考研公考课程网盘资源已接入下方"网盘资源"区块。', url: '' },
    ],
    competitions: [],
  },
];
