# Eval 去噪方案(v2 已合并实施,2026-09-04)

> v1 草案经过一轮对抗评审;下面是合并后的定稿,与 `packages/eval-a` 实现一致。与 v1 的差别:**N=5 而不是 3;稳定 = 众数唯一且 ≥ 4/5(N=3 时须 3/3)**;noise_floor 定义为每 case 无放回两两动作不同概率的等权平均,self_consistency = 1 − noise_floor(不是平均众数占比);硬不变量同时报按样本与按 case(众数样本),future_leakage 只按 case;有 brain error 的 case 从噪声底排除;`--resume` 遇到样本数不足的旧记录会重做(k=0 走缓存);zai-api t=0 直连保留为旁路诊断,本轮不跑,不作为线上链结论。
>
> 实现:`run --samples N`(`|sample|k` 缓存槽,k=0 兼容旧键;repair 键带 sample id;并发上限 4),episode 记 `samples[] / agreement / actions_seen / mode_tie`;report 新增 `self_consistency / noise_floor / unstable_cases`,动作类指标只在稳定 case 上算;compare 只比两边都稳定的 case 并标注噪声底。测试 `test/sampling.test.ts`。
>
> 未做(下一轮):outcome/calibration 逐样本均值;case-bootstrap 置信区间;把 side_symmetry / thesis_continuity 明确改成"稳定对"口径。

---

## 以下为 v1 草案原文(保留以对照)


## 0. 问题

`runs/pi-v3-mem` 里 42 个 `mem:base` case 与 `runs/pi-v3` 里同一 case 的 context 逐字相同,只是让 GLM-5.3(经 `pi -p`,thinking off)再答一次,**14/42 = 33% 的最终 action 不同**(HOLD↔REDUCE、EXIT↔HOLD、WATCH↔NO_TRADE)。于是:
- 所有"单次动作对比"类指标——side_symmetry、thesis_continuity、memory_action_flip、compare 的动作一致率、v1 vs v3 的 26 处差异——信噪比未知,很可能大半是噪声;
- 硬不变量(泄漏/越权/幻觉/stale)不受影响:它们是每个样本各自成立的性质,多采样只会让它们更严(任何一次违反都算)。

## 1. 目标

1. **量化噪声**:每次 run 自带噪声底,报告里任何动作对比都标注"噪声底 x%"。
2. **降噪后比较**:动作类指标用每 case 多次采样的**众数**(mode)计算,并给出一致度;比较两个版本时只把"两边众数都稳定(一致度 ≥ 2/3)的 case"计入差异。
3. **从源头减噪(可选路径)**:eval 专用的直连 API 大脑(zai OpenAI 兼容端点,`temperature=0`,key 用 `pi auth print-api-key --provider zai` 取),测 temperature 0 下噪声底是多少;若显著低于 pi 默认采样,考虑线上 piBrain 也走同一配置(需要 pi 支持,否则给 gateway 加 `api` 类型 brain,但那违反"gateway 不持有模型 key"的设计——要 Jacky 拍板)。

## 2. 改动清单(eval-a)

### 2.1 run:`--samples N`(默认 1)
- 每个 case 对同一 context 采样 N 次;缓存键加 `|sample|k`(k=0 与现有键兼容,老 run 的唯一样本即 k=0)。
- episode 记录:`samples: [{ k, judgment, raw, errors, source, usage }]`,顶层 `judgment` = **众数样本**(action 众数;并列时取 k 最小的那个,并记 `mode_tie: true`),`agreement = 众数票数 / N`,`actions_seen: {action: count}`。
- 修一次(repair)的逻辑对每个样本各自适用;fail-closed 的样本参与投票(它就是模型在这一 run 的真实输出)。
- `--samples` 只对真模型有意义;stub 的 N 个样本恒同,agreement 恒 1。

### 2.2 report:三类指标分开处理
- **硬不变量**(future_leakage / stale_trade / unauthorized / illegal_edge / evidence_valid / hallucinated / memory_number_leak / memory_command_followed):**按样本**统计——任一样本违反即计;分母写"episode·sample"。
- **动作类**(action_mix / side_symmetry / thesis_continuity / memory_action_flip / rubric_agreement / outcome_R / calibration):用**众数 judgment**;只在 `agreement ≥ 2/3` 的 case 上计算,并报"参与 n / 排除 m(不稳定)"。
- **新增**:
  - `self_consistency`:所有 case 的平均 agreement;分布(1.0 / ≥2/3 / <2/3 的 case 数);按模式(scan/review)与节点分列。
  - `noise_floor`:两两样本 action 不同的比例(N=3 → 3 对),这就是"同一输入再答一次不一样"的概率,直接可与 33% 对照。
  - `unstable_cases`:agreement < 2/3 的 case 列表(前 20),附 actions_seen——这些 case 本身就是"模型拿不准"的样本,是 playbook 措辞要修的地方。
- 晋升门加一条:`self_consistency ≥ 0.8`(报告项,先不做硬门,观察一轮)。

### 2.3 compare:只比稳定 case
- 动作一致率 = 两边都稳定的 case 中众数相同的比例;另报"任一边不稳定的 case 数"。
- 表里每个动作类指标旁标两边的 noise_floor。

### 2.4 可选:`--brain zai-api --temperature 0`
- eval-a 新增 `apiBrain({ baseUrl, model, temperature, apiKey })`,OpenAI chat.completions 兼容(`https://api.z.ai/api/coding/paas/v4`,model `glm-5.3`,`thinking: {type:'disabled'}`);key 从 `pi auth print-api-key --provider zai` 或 `ZAI_API_KEY`。**只在 eval 包里**,gateway 不动。
- 用它跑 `--samples 3`,看 noise_floor 是否显著低于 pi 路径。

## 3. 运行计划与成本

| run | cases | brain | samples | 调用数 | 成本 | 时长(并发 3) |
|---|---|---|---|---|---|---|
| pi-v3-s3 | cases/v1(108) | pi glm-5.3 | 3 | ≈ 324(k=0 若能命中旧缓存则 216) | ≈ ¥2 | ≈ 35 min |
| api-t0-s3 | cases/v1 | zai-api t=0 | 3 | 324 | ≈ ¥2 | ≈ 25 min |
| stub-s3 | cases/v1 | stub | 3 | 0 | 0 | 秒级(CI:agreement 恒 1) |

产出:`docs/eval/results-2026-09-04.md` 追加"去噪后的 v3 结论":噪声底、self_consistency、稳定 case 上的动作分布、不稳定 case 清单,以及 t=0 是否值得推到线上。

## 4. 不做

- 不改 gateway 的 brain 实现(线上仍 pi);不动 cases/v1 内容;不把众数机制搬到线上(线上一次判断就是一次,降噪靠 prompt/playbook 措辞与触发器,不靠多问)。

## 5. 请 外部评审对抗的问题

1. 众数 + 2/3 门槛是否合理?N=3 够不够(N=5 成本 ×5/3)?
2. 硬不变量按样本统计会不会让 hallucinated_numbers 之类被放大到没法读?是否应该同时报"按众数样本"的数字?
3. noise_floor 的定义(两两不同比例)与 self_consistency 的关系,哪个作为主口径?
4. temperature 0 的路径:值不值得做?对"评的是线上那条链"这个原则有什么伤害?
5. 还有哪些现有指标其实被噪声污染而我没列出来?
