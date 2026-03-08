export const RISK_HEALTH_RE =
  /心脏|心肺|冠心|心血管|高血压|糖尿病|哮喘|慢性病|手术|过敏|孕|老人|老年|儿童|行动不便|不能爬山|不能久走|焦虑|惊恐|抑郁|危险|安全|急救|摔倒|health|medical|heart|cardiac|anxiety|panic|depression|safety|risk/i;

export const MEDICAL_HEALTH_RE =
  /心脏|心肺|冠心|冠脉|冠状动脉|心血管|支架|心梗|高血压|糖尿病|哮喘|慢性病|手术|过敏|孕|行动不便|不能爬山|不能久走|焦虑|惊恐|抑郁|health|medical|heart|cardiac|anxiety|panic|depression|stent/i;

export const HEALTH_STRATEGY_ACTIVITY_RE =
  /低强度|慢节奏|轻松|少走路|少步行|减少体力|不要太累|不想太累|不太折腾|不要太折腾|少折腾|不想太赶|不要太赶|别太赶|节奏别太赶|行程别太赶|行程不能安排太满|不要安排太满|别安排太满|安排不要太满|不要爬坡|别爬坡|不能爬坡|不宜剧烈|避免剧烈|low[-\s]?intensity|light[-\s]?activity|low[-\s]?exertion|avoid overexertion|low[-\s]?hassle|not too packed|don'?t pack (?:the )?(?:trip|itinerary) too tightly|avoid slopes?|avoid uphill/i;

export const HEALTH_STRATEGY_DIET_RE =
  /低盐|低脂|高纤维|清淡|少油|少糖|地中海饮食|low[-\s]?salt|low[-\s]?fat|high[-\s]?fiber|diet/i;

export const LOW_HASSLE_TRAVEL_RE =
  /不想太累|不要太累|不太折腾|不要太折腾|少折腾|轻松一点|慢节奏|低强度|减少体力|少走路|少步行|不想太赶|不要太赶|别太赶|节奏别太赶|行程别太赶|行程不能安排太满|不要安排太满|别安排太满|安排不要太满|不要爬坡|别爬坡|不能爬坡|中老年|老人|老年|带爸妈|父母同行|family[-\s]?friendly|senior[-\s]?friendly|low[-\s]?hassle|easy[-\s]?pace|not too packed|don'?t pack (?:the )?(?:trip|itinerary) too tightly|avoid slopes?|avoid uphill/i;

export const MINIMIZE_HOTEL_SWITCH_RE =
  /少换酒店|别换太频繁|不要每天换酒店|不想每天换酒店|不想频繁换酒店|不想老换酒店|少搬酒店|减少换酒店|住同一家酒店|同一家酒店连住|minimi[sz]e hotel changes|avoid changing hotels frequently/i;

export const TRANSPORT_CONVENIENCE_RE =
  /交通方便|交通便利|地铁近|离地铁近|靠近地铁|近地铁|地铁站附近|步行可达|少换乘|换乘少|直达|出行方便|near metro|near subway|easy transit|well[-\s]?connected|walkable/i;

export const SAFETY_STRATEGY_RE =
  /治安|安全|安全感|不被坑|防坑|防骗|诈骗|抢劫|夜间|夜里|夜晚|security|safety|safe|scam|fraud|danger|risk/i;

export const LANGUAGE_CONSTRAINT_RE =
  /不会英语|不会英文|英语不好|英文不好|语言不通|语言障碍|翻译|口译|同传|不懂西语|不懂法语|不会当地语言|沟通困难|(?:法语|阿拉伯语|西语|西班牙语|葡语|葡萄牙语|德语|日语|韩语|英语|英文)(?:和|与|及|、|,|，)?(?:法语|阿拉伯语|西语|西班牙语|葡语|葡萄牙语|德语|日语|韩语|英语|英文|当地语言)?(?:都不会|都不懂|不会|不懂|不太会|不太懂|不好)|(?:不会|不懂|不太会|不太懂)[^，。；;\n]{0,18}(?:法语|阿拉伯语|西语|西班牙语|葡语|葡萄牙语|德语|日语|韩语|英语|英文|当地语言)|speak english|english poor|language barrier|translation/i;

export const HARD_CONSTRAINT_RE = /不能|不宜|避免|禁忌|必须|只能|不要|不可|不得|无法|不方便|不能够/i;
export const HARD_REQUIRE_RE = /硬性要求|一定要|必须|务必|绝对/i;
export const CRITICAL_PRESENTATION_RE = /汇报|报告|演讲|讲论文|宣讲|presentation|talk|keynote|答辩|讲座/i;
export const HARD_DAY_FORCE_RE = /强制|必须|务必|一定|不得缺席|需要留|要留|预留|留出|专门留|硬性/i;
export const HARD_DAY_ACTION_RE =
  /用于|留给|安排|处理|办理|会见|见|拜访|探亲|参加|参会|汇报|报告|演讲|发表|讲论文|presentation|面签|考试|答辩|就医|看病|拍摄|采访|婚礼|葬礼|仪式|陪同/i;

export const CULTURE_PREF_RE = /人文|历史|文化|博物馆|古城|古镇|遗址|美术馆|展览|文博/i;
export const NATURE_TOPIC_RE = /自然景观|自然风光|爬山|徒步|森林|湿地|海边|户外/i;
export const PREFERENCE_MARKER_RE = /喜欢|更喜欢|偏好|倾向|感兴趣|想看|想去|不感兴趣|不喜欢|厌恶/i;

export const ITINERARY_NOISE_RE = /第[一二三四五六七八九十0-9]+天|上午|中午|下午|晚上|行程|建议|入住|晚餐|午餐|景点|游览|返回|酒店|餐馆|安排如下/i;

export const STRUCTURED_PREFIX_RE =
  /^(意图|目的地|同行人数|预算(?:上限)?|行程时长|总行程时长|会议时长|城市时长|停留时长|会议关键日|关键会议日|论文汇报日|健康约束|语言约束|限制因素|冲突提示|景点偏好|活动偏好|住宿偏好|交通偏好|饮食偏好|子地点|人数|时长)[:：]/;

export const DESTINATION_NOISE_RE =
  /之外|其他时间|这座城|这座城市|城市里|到场|pre|汇报|报告|论文|会议|参加一个|必须|想逛|逛一逛|计划|安排|准备|打算|预算|经费|花费|费用|一天|两天|三天|四天|五天|六天|七天|八天|之前|之后|然后|并且|但是|同时|顺带|顺便|顺路|顺道|其中|其中有|其余|其他时候|海地区|该地区|看球|观赛|比赛|打卡|参观|游览|演讲|发表|现场观看|现场观赛|现场看|观看|观赏|所以这|因此|另外|此外|这三天|这几天|人民币|当地|本地|本市|本城|这边|那边|只含当地|仅含当地|当地游|当地玩|国内|国外|境内|境外|国内任务|国外任务|重点片区|重点|片区|比较好|更好|好一点|合适一点|更合适|比较合适|很高的建筑|高空建筑|摩天楼|高楼|楼顶|屋顶观景|高空观景/i;

export const PLACE_STOPWORD_RE =
  /我|你|他|她|我们|你们|他们|除了|其他|其中|其中有|其余|时间|必须|到场|之前|之后|然后|安排|计划|准备|打算|预算|经费|花费|费用|参加|会议|汇报|报告|pre|chi|天|行程|顺带|顺便|顺路|顺道|海地区|该地区|看球|观赛|比赛|现场观看|现场观赛|现场看|观看|观赏|演讲|发表|所以这|因此|另外|此外|人民币|当地|本地|本市|本城|这边|那边|国内|国外|境内|境外|国内任务|国外任务|重点片区|重点|片区/i;

export const NON_PLACE_TOKEN_RE =
  /^(人民币|预算|经费|花费|费用|准备|打算|计划|安排|行程|旅游|旅行|出行|自由行|参会|开会|会议|汇报|报告|演讲|发表|一天|一周|一月|一人|多人|现场|现场观看|现场观赛|观看|国内|国外|境内|境外|国内任务|国外任务|重点|重点片区|片区)$/i;

export const NON_DESTINATION_COMPARATIVE_RE =
  /^(?:(?:比(?:较)?)|更|比较|尽量|优先|最好|稍微)?\s*(?:好|更好|比较好|好些|好点|好一点|合适|合适点|合适一点|更合适|比较合适|更安全|比较安全|更稳妥|比较稳妥|更方便|比较方便|更便宜|比较便宜|更舒适|比较舒适|更舒服|比较舒服|更划算|比较划算)(?:的地方|一点)?(?:吧|呢|呀|啊|吗)?$/i;

export const COUNTRY_PREFIX_RE =
  /^(中国|美国|英国|法国|德国|意大利|西班牙|葡萄牙|荷兰|比利时|瑞士|奥地利|日本|韩国|新加坡|泰国|马来西亚|印度尼西亚|澳大利亚|加拿大|新西兰|阿联酋)/;
