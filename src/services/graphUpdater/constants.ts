export const RISK_HEALTH_RE =
  /心脏|心肺|冠心|心血管|高血压|糖尿病|哮喘|慢性病|手术|过敏|孕|老人|老年|儿童|行动不便|不能爬山|不能久走|危险|安全|急救|摔倒|health|medical|heart|cardiac|safety|risk/i;

export const MEDICAL_HEALTH_RE =
  /心脏|心肺|冠心|心血管|高血压|糖尿病|哮喘|慢性病|手术|过敏|孕|行动不便|不能爬山|不能久走|health|medical|heart|cardiac/i;

export const LANGUAGE_CONSTRAINT_RE =
  /不会英语|不会英文|英语不好|英文不好|语言不通|语言障碍|翻译|口译|同传|不懂西语|不懂法语|不会当地语言|沟通困难|speak english|english poor|language barrier|translation/i;

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
  /^(意图|目的地|同行人数|预算(?:上限)?|行程时长|总行程时长|会议时长|城市时长|停留时长|会议关键日|关键会议日|论文汇报日|健康约束|语言约束|景点偏好|活动偏好|住宿偏好|交通偏好|饮食偏好|子地点|人数|时长)[:：]/;

export const DESTINATION_NOISE_RE =
  /之外|其他时间|这座城|这座城市|城市里|到场|pre|汇报|报告|论文|会议|参加一个|必须|想逛|逛一逛|计划|安排|一天|两天|三天|四天|五天|六天|七天|八天|之前|之后|然后|并且|但是|同时|顺带|顺便|顺路|顺道|其中|其中有|其余|其他时候|海地区|该地区|看球|观赛|比赛|打卡|参观|游览|演讲|发表|所以这|因此|另外|此外|这三天|这几天/i;

export const PLACE_STOPWORD_RE =
  /我|你|他|她|我们|你们|他们|除了|其他|其中|其中有|其余|时间|必须|到场|之前|之后|然后|安排|计划|参加|会议|汇报|报告|pre|chi|天|行程|顺带|顺便|顺路|顺道|海地区|该地区|看球|观赛|比赛|演讲|发表|所以这|因此|另外|此外/i;

export const COUNTRY_PREFIX_RE =
  /^(中国|美国|英国|法国|德国|意大利|西班牙|葡萄牙|荷兰|比利时|瑞士|奥地利|日本|韩国|新加坡|泰国|马来西亚|印度尼西亚|澳大利亚|加拿大|新西兰|阿联酋)/;
