<template>
  <div class="kfb-skill-editor">
    <div v-if="!model" class="empty">技能数据为空，请先解密。</div>

    <template v-else>
      <!-- ===== 脚本注入工具栏 ===== -->
      <section class="sec">
        <h3 class="sec-title">脚本注入工具栏<span class="sec-sub">向任意帧插入 横幅 / 常驻横幅 / 增伤 / 跳转 / 召唤物 / 无敌 / 对话</span></h3>
        <div class="inject-bar">
          <div class="inj-row">
            <span class="inj-label">片段</span>
            <el-select v-model="injClipIdx" size="small" class="inj-clip" placeholder="选择动作片段">
              <el-option v-for="(c, i) in allClips" :key="i" :label="`${c.name || '(未命名)'}（${c.totalframes ?? 0}帧）`" :value="i" />
            </el-select>
            <span class="inj-label">帧</span>
            <el-select v-model="injFrame" size="small" class="inj-frame" filterable>
              <el-option v-for="f in frameOptions" :key="f.idx" :value="f.idx">
                <span class="fo-idx">帧 {{ f.idx }}</span>
                <span class="frame-tag" :class="f.cls">{{ f.tag }}</span>
              </el-option>
            </el-select>
            <span class="inj-label">脚本</span>
            <el-select v-model="injType" size="small" class="inj-type">
              <el-option value="banner" label="🖼️ 横幅播报 (20083)" />
              <el-option value="permanentBanner" label="📌 常驻横幅 (20300)" />
              <el-option value="damage" label="💥 全局增伤 (1013)" />
              <el-option value="jump" label="⏭️ 帧跳转 (1031)" />
              <el-option value="summon" label="✨ 召唤物 (10001)" />
              <el-option value="invincible" label="🛡️ 无敌帧开关 (1056)" />
              <el-option value="dialog" label="💬 剧情对话 (10024)" />
              <el-option value="acceptVkey" label="🤚 接招派生 (1007)" />
            </el-select>
          </div>

          <div class="inj-row inj-params">
            <template v-if="injType === 'banner'">
              <label>标题</label>
              <el-input v-model="injP.title" size="small" class="inj-input" placeholder="可留空" />
              <label>内容</label>
              <el-input v-model="injP.content" size="small" class="inj-input-wide" placeholder="横幅文字" />
              <label>自动关闭(帧)</label>
              <el-input-number v-model="injP.autoClose" size="small" :min="0" :max="9999" :controls="false" class="inj-num" />
            </template>
            <template v-else-if="injType === 'permanentBanner'">
              <label>Lua函数</label>
              <el-input v-model="injP.strFuncName" size="small" class="inj-input" placeholder="ShowPlotGuideTips" />
              <label>正文(lstArgs[2])</label>
              <el-input v-model="injP.pbArgs[2]" size="small" class="inj-input-wide" placeholder="横幅文字" />
              <label>位置x,y,z(lstArgs[3])</label>
              <el-input v-model="injP.pbArgs[3]" size="small" class="inj-input" placeholder="0,220,0" />
              <span class="inj-tip">常驻显示不自动关闭；下方可微调全部 10 个参数</span>
              <div class="pb-args">
                <div v-for="i in 10" :key="'pb' + i" class="pb-arg">
                  <span class="pb-arg-l">[{{i - 1}}]</span>
                  <el-input v-model="injP.pbArgs[i - 1]" size="small" :placeholder="`lstArgs[${i - 1}]`" />
                </div>
              </div>
            </template>
            <template v-else-if="injType === 'damage'">
              <label>增伤倍率</label>
              <el-input-number v-model="injP.rate" size="small" :min="1" :max="999999999" :controls="false" class="inj-num" />
              <label>关联命中帧</label>
              <el-input-number v-model="injP.objFrame" size="small" :min="0" :controls="false" class="inj-num" />
              <span class="inj-tip">建议注入到含攻击盒的帧；倍率写入 specialEnhanceAtkRate</span>
            </template>
            <template v-else-if="injType === 'jump'">
              <label>目标帧</label>
              <el-input-number v-model="injP.targetFrame" size="small" :min="0" :controls="false" class="inj-num" />
              <span class="inj-tip">argInt = 跳转到的帧索引</span>
            </template>
            <template v-else-if="injType === 'summon'">
              <label>assetId</label>
              <el-input v-model="injP.assetId" size="small" class="inj-input" placeholder="如 90059401" />
              <label>方向</label>
              <el-select v-model="injP.dir" size="small" class="inj-num">
                <el-option :value="0" label="0 默认" />
                <el-option :value="1" label="1 正向" />
                <el-option :value="-1" label="-1 反向" />
              </el-select>
              <el-checkbox v-model="injP.isAoyi" size="small">奥义伤害(isAoyi)</el-checkbox>
            </template>
            <template v-else-if="injType === 'invincible'">
              <el-radio-group v-model="injP.on" size="small">
                <el-radio-button :value="true">开无敌 (argInt=1)</el-radio-button>
                <el-radio-button :value="false">关无敌 (argInt=0)</el-radio-button>
              </el-radio-group>
              <span class="inj-tip">通常在起始帧「开」，结束帧「关」，中间帧保持无敌</span>
            </template>
            <template v-else-if="injType === 'dialog'">
              <label>标题</label>
              <el-input v-model="injP.title" size="small" class="inj-input" placeholder="可留空" />
              <label>正文</label>
              <el-input v-model="injP.text" size="small" class="inj-input-wide" placeholder="对话文字" />
              <el-checkbox v-model="injP.auto" size="small">自动播放</el-checkbox>
            </template>
            <template v-else-if="injType === 'acceptVkey'">
              <label>接招类型</label>
              <el-select v-model="injP.vkeyType" size="small" class="inj-num">
                <el-option :value="1011" label="1011 技能互切(触发特效)" />
                <el-option :value="1005" label="1005 普攻连招(续段)" />
              </el-select>
              <label>按键</label>
              <el-select v-model="injP.vkeyValue" size="small" class="inj-num">
                <el-option :value="101" label="101 一技能" />
                <el-option :value="105" label="105 二技能" />
                <el-option :value="100" label="100 普攻" />
                <el-option :value="102" label="102 三技能" />
                <el-option :value="103" label="103 四技能" />
                <el-option :value="104" label="104 五技能" />
                <el-option :value="107" label="107 奥义" />
              </el-select>
              <label>特效段</label>
              <el-select v-model="injP.effectDictKey" size="small" class="inj-input">
                <el-option value="9005922" label="9005922 (eff 90059213)" />
                <el-option value="9005923" label="9005923 (eff 90059212)" />
                <el-option value="9005924" label="9005924 (eff 90059215)" />
              </el-select>
              <span class="inj-tip">技能互切接招：按指定键触发特效段（特效+音效），不取消当前动作</span>
            </template>
          </div>

          <div class="inj-row inj-action">
            <el-button type="primary" size="small" @click="injectScript">注入脚本</el-button>
            <span v-if="injWarn" class="inj-hint warn">{{ injWarn }}</span>
            <span v-if="injOk" class="inj-hint ok">{{ injOk }}</span>
          </div>
        </div>
      </section>

      <!-- ===== 帧动画联动预览 ===== -->
      <section class="sec">
        <h3 class="sec-title">帧动画联动预览<span class="sec-sub">选片段→看动作→选帧→注入，所见即所得</span></h3>
        <div class="fa-bar">
          <el-button size="small" @click="faFileInput?.click()" :loading="faImporting">
            <el-icon style="margin-right: 4px"><i-el-folder-opened /></el-icon>导入帧动画
          </el-button>
          <input ref="faFileInput" type="file" multiple accept=".assetbundle" style="display:none" @change="onFaFileSelected" />

          <template v-if="faGroups.length">
            <span class="inj-label">动画绑定</span>
            <el-select v-model="faBinding" size="small" class="fa-binding" placeholder="手动选择动画" filterable>
              <el-option v-for="g in faGroups" :key="g.name" :label="`${g.name} (${g.frameCount}帧)`" :value="g.name" />
            </el-select>
            <span v-if="faAutoMatched" class="fa-badge-auto">自动匹配</span>
          </template>

          <span v-if="faStatus" class="inj-tip">{{ faStatus }}</span>
        </div>

        <div v-if="faCurrentGroup" class="fa-player">
          <div class="fa-image-wrap">
            <img v-if="faImageData" :src="faImageData" class="fa-frame-img" :key="faImageData" />
            <div v-else class="fa-placeholder">帧加载中…</div>
            <div v-if="faCurrentFrameScripts.length" class="fa-script-badge" :title="faCurrentFrameScripts.map(s => s.label).join(', ')">
              {{ faCurrentFrameScripts.length }} 脚本
            </div>
          </div>
          <div class="fa-controls">
            <el-button-group size="small">
              <el-button @click="faGoToFrame(0)" :disabled="faCurrentFrame === 0"><el-icon><i-el-d-arrow-left /></el-icon></el-button>
              <el-button @click="faPrev" :disabled="faCurrentFrame === 0"><el-icon><i-el-arrow-left /></el-icon></el-button>
              <el-button :type="faPlaying ? 'warning' : 'primary'" @click="faTogglePlay">
                <el-icon><i-el-video-pause v-if="faPlaying" /><i-el-video-play v-else /></el-icon>
              </el-button>
              <el-button @click="faNext" :disabled="faCurrentFrame === faTotalFrames - 1 && !faLoop"><el-icon><i-el-arrow-right /></el-icon></el-button>
              <el-button @click="faGoToFrame(faTotalFrames - 1)" :disabled="faCurrentFrame === faTotalFrames - 1"><el-icon><i-el-d-arrow-right /></el-icon></el-button>
            </el-button-group>
            <div class="fa-slider-wrap">
              <span class="fa-counter">{{ faCurrentFrame + 1 }} / {{ faTotalFrames }}</span>
              <div class="fa-slider-container">
                <el-slider v-model="faCurrentFrame" :min="0" :max="Math.max(0, faTotalFrames - 1)" :step="1" size="small" :show-tooltip="false" />
                <div class="fa-markers">
                  <div
                    v-for="m in faInjectMarkers"
                    :key="m.frame"
                    class="fa-marker"
                    :class="m.cls"
                    :style="{ left: m.pos + '%' }"
                    :title="`帧${m.frame}: ${m.label}`"
                    @click="faGoToFrame(m.animFrame)"
                  />
                </div>
              </div>
            </div>
            <el-checkbox v-model="faLoop" size="small">循环</el-checkbox>
            <span class="inj-label">FPS</span>
            <el-input-number v-model="faFps" :min="1" :max="60" size="small" :controls="false" style="width: 56px" />
          </div>
        </div>
      </section>

      <!-- ===== 技能 CD / 能量 ===== -->
      <section class="sec">
        <h3 class="sec-title">技能 CD / 能量<span class="sec-sub">一键控制 ↓</span></h3>
        <div class="bulk-bar">
          <el-button size="small" @click="bulkSetCD(true)">全部开启CD</el-button>
          <el-button size="small" @click="bulkSetCD(false)">全部关闭CD</el-button>
          <el-button size="small" @click="bulkSetIgnoreCD(true)">全部无视CD</el-button>
          <el-button size="small" @click="bulkSetIgnoreCD(false)">取消无视CD</el-button>
          <el-button size="small" @click="bulkSetEnable(true)">全部可用</el-button>
          <el-button size="small" @click="bulkSetEnable(false)">全部禁用</el-button>
          <el-button size="small" @click="bulkSetRecordCD(false)">不记录CD</el-button>
          <el-button size="small" @click="bulkSetRecordCD(true)">记录CD</el-button>
        </div>
        <div class="skill-cards" :key="'sk' + renderKey">
          <div v-for="g in model.skills" :key="'s' + g.actionId" class="skill-card">
            <div class="card-head">
              <span class="aid">技能槽 actionId = {{ g.actionId }}</span>
              <span class="counts">
                <span v-if="g.cd.length">SetSkillArg ×{{ g.cd.length }}</span>
                <span v-if="g.ep.length">EP ×{{ g.ep.length }}</span>
                <span v-if="g.icons.length">图标 ×{{ g.icons.length }}</span>
              </span>
            </div>

            <el-collapse>
              <el-collapse-item v-if="g.cd.length" :title="`SetSkillArg（技能可用 / CD 控制，${g.cd.length} 条）`">
                <div class="field-help">
                  <b>可用(enableSetEnable/isEnable)</b>：控制技能是否可使用——enableSetEnable=True 时 isEnable 的值生效<br/>
                  <b>CD开关(enabelSetCD)</b>：True=使用技能时记录CD，False=不记录CD（相当于无CD）<br/>
                  <b>无视CD(isIgnoreCD)</b>：True=跳过CD检查，即使CD未转完也能放<br/>
                  <b>耗EP开关/无视耗EP</b>：同上，控制 EP 消耗检查<br/>
                  <b>可用性(enableSetUseful/isUseful)</b>：控制技能是否"有效"——False 时技能可释放但无效果
                </div>
                <div class="row-head">
                  <span>可用</span><span>CD 开关</span><span>无视CD</span><span>耗EP开关</span><span>无视耗EP</span><span>可用性开关</span><span>可用</span>
                </div>
                <div v-for="(e, i) in g.cd" :key="'cd' + g.actionId + '_' + i" class="cd-row">
                  <el-switch v-model="e.ref.enableSetEnable" size="small" @change="onAnyChange" />
                  <el-switch v-model="e.ref.enabelSetCD" size="small" @change="onAnyChange" />
                  <el-switch v-model="e.ref.isIgnoreCD" size="small" @change="onAnyChange" />
                  <el-switch v-model="e.ref.enableSetManacost" size="small" @change="onAnyChange" />
                  <el-switch v-model="e.ref.isIgnoreManacost" size="small" @change="onAnyChange" />
                  <el-switch v-model="e.ref.enableSetUseful" size="small" @change="onAnyChange" />
                  <el-switch v-model="e.ref.isUseful" size="small" @change="onAnyChange" />
                </div>
              </el-collapse-item>

              <el-collapse-item v-if="g.ep.length" :title="`SetSkillEpAttributeArg（EP / 技能CD，${g.ep.length} 条）`">
                <div class="ep-grid">
                  <div v-for="(e, i) in g.ep" :key="'ep' + g.actionId + '_' + i" class="ep-item">
                    <el-checkbox v-model="e.ref.enable" @change="onAnyChange">启用</el-checkbox>
                    <label>技能CD</label>
                    <el-input-number v-model="e.ref.skillCD" size="small" :controls="false" @change="onAnyChange" />
                    <label>EP上限</label>
                    <el-input-number v-model="e.ref.maxEpCount" size="small" :controls="false" @change="onAnyChange" />
                    <label>初始EP</label>
                    <el-input-number v-model="e.ref.initEpCount" size="small" :controls="false" @change="onAnyChange" />
                  </div>
                </div>
              </el-collapse-item>

              <el-collapse-item v-if="g.icons.length" :title="`ChangeSkillIcon（图标 / CD槽，${g.icons.length} 条）`">
                <div class="icon-grid">
                  <div v-for="(e, i) in g.icons" :key="'ic' + g.actionId + '_' + i" class="icon-item">
                    <span class="icon-id">{{ e.iconId || '（无图）' }}</span>
                    <label>CDIndex</label>
                    <el-input-number v-model="e.ref.CDIndex" size="small" :controls="false" @change="onAnyChange" />
                    <label>maxMana</label>
                    <el-input-number v-model="e.ref.maxMana" size="small" :controls="false" @change="onAnyChange" />
                    <el-checkbox v-model="e.ref.IsRecordSkillCD" @change="onAnyChange">记录CD</el-checkbox>
                  </div>
                </div>
              </el-collapse-item>

              <el-collapse-item v-if="g.multi.length" :title="`SetMultiStateSkillArg（多段技能状态，${g.multi.length} 条）`">
                <div class="field-help">
                  <b>激活帧(activeFrame)</b>：技能从第几帧开始"生效"——在此之前可以取消/打断，到达此帧后技能"确认释放"，CD 从此帧开始计时<br/>
                  <b>CD计时(startCDTimeStyle)</b>：1=释放时起算（到激活帧即开始CD），2=命中后起算（必须打中才计CD），0=不计时<br/>
                  <b>skillCD</b>：CD 时长占位符（实际秒数由外部配置表 SkillConfig2.cd 决定，KFB 内通常为 0）<br/>
                  <b>skillIcon</b>：该段状态切换后显示的技能图标资源 ID，不是动作触发器<br/>
                  <b>CDIndex</b>：该技能使用哪个 CD 槽位（-1=无独立CD槽，多个技能可共享同一槽位）<br/>
                  <b>IsRecordSkillCD</b>：是否在使用时记录 CD（False=不记录，相当于无 CD）
                </div>
                <div v-for="(m, i) in g.multi" :key="'mu' + g.actionId + '_' + i" class="multi-card">
                  <div class="multi-head">
                    <span>多段状态 #{{ i }}（actionId={{ m.actionId }}）</span>
                    <span class="del">重置<el-switch v-model="m.ref.reset" size="small" @change="onAnyChange" /></span>
                    <label>incMp</label>
                    <el-input-number v-model="m.ref.incMp" size="small" :controls="false" @change="onAnyChange" />
                  </div>
                  <div v-for="(st, si) in m.states" :key="'st' + g.actionId + '_' + i + '_' + si" class="state-row">
                    <span class="state-idx">stateIndex={{ st.ref.stateIndex }}</span>
                    <label>skillCD</label>
                    <el-input-number v-model="st.ref.skillCD" size="small" :controls="false" @change="onAnyChange" />
                    <label>激活帧</label>
                    <el-input-number v-model="st.ref.activeFrame" size="small" :controls="false" @change="onAnyChange" />
                    <label>CD计时</label>
                    <el-select v-model="st.ref.startCDTimeStyle" size="small" @change="onAnyChange">
                      <el-option :value="1" label="1-释放时起算" />
                      <el-option :value="2" label="2-命中后起算" />
                      <el-option :value="0" label="0" />
                    </el-select>
                    <label>图标</label>
                    <el-input v-model="st.ref.skillIcon" size="small" @change="onAnyChange" />
                  </div>
                </div>
              </el-collapse-item>

              <el-collapse-item v-if="g.accept.length" :title="`AcceptVKeyArg（接招 CD/封印 检查，${g.accept.length} 条）`">
                <p class="acc-hint">提示：CD 秒数不在此处，仅控制"接招时是否要求 CD/未被封印"。</p>
                <div class="acc-grid">
                  <div v-for="(a, i) in g.accept" :key="'ac' + g.actionId + '_' + i" class="acc-row">
                    <span class="acc-key">键{{ a.argInt }} 段{{ a.argStr || '—' }}</span>
                    <el-checkbox v-model="a.ref.checkIsInCD" @change="onAnyChange">检查CD</el-checkbox>
                    <el-checkbox v-model="a.ref.checkIsSealed" @change="onAnyChange">检查封印</el-checkbox>
                  </div>
                </div>
              </el-collapse-item>
            </el-collapse>
          </div>
        </div>
        <div class="no-skill-hint" v-if="!model.skills.length">未检测到技能按钮脚本。</div>
      </section>

      <!-- ===== 技能范围（攻击判定盒） ===== -->
      <section class="sec">
        <h3 class="sec-title">技能范围（攻击判定盒）<span class="sec-sub">单位=米，仅显示含攻击盒的帧</span></h3>
        <div class="range-toolbar">
          <div class="rt-row">
            <span class="rt-label">范围倍率</span>
            <el-input-number v-model="rangeMult" :min="0.1" :max="10" :step="0.1" :precision="2" size="small" class="rt-mult" />
            <el-checkbox v-model="scaleAttack" size="small">攻击判定</el-checkbox>
            <el-checkbox v-model="scaleWeapon" size="small">武器判定</el-checkbox>
            <el-checkbox v-model="scaleHurt" size="small">受击框</el-checkbox>
            <el-button size="small" type="primary" @click="applyRangeScale" :disabled="!affectedCount">应用倍率</el-button>
            <span class="rt-count">将影响 {{ affectedCount }} 个判定盒</span>
          </div>
          <div class="rt-row">
            <span class="rt-label">缩放轴</span>
            <el-checkbox v-model="axisX" size="small">X</el-checkbox>
            <el-checkbox v-model="axisY" size="small">Y</el-checkbox>
            <el-checkbox v-model="axisZ" size="small">Z</el-checkbox>
            <span class="rt-sep">|</span>
            <el-checkbox v-model="enableZeroReplace" size="small">0值替换为</el-checkbox>
            <el-input-number v-model="zeroReplaceVal" :min="0" :step="0.1" :precision="3" size="small" class="rt-zero" :disabled="!enableZeroReplace" />
            <span class="rt-hint">勾选后，原值为0的轴先替换为此值再乘倍率</span>
          </div>
        </div>
        <div class="clip-table-wrap" v-if="rangeClips.length">
          <div class="clip-table-head">
            <span class="cth-title">应用范围（取消勾选可排除）</span>
            <el-checkbox v-model="clipAllChecked" size="small" @change="onClipAllChange">全选</el-checkbox>
          </div>
          <div class="clip-table">
            <label v-for="c in rangeClips" :key="'chk' + c.name" class="clip-chip" :class="{ off: !clipChecked[c.name] }">
              <el-checkbox v-model="clipChecked[c.name]" size="small" @change="onClipCheckChange" />
              <span class="chip-name">{{ c.name }}</span>
              <span class="chip-cnt">{{ c.ranges.length }}</span>
            </label>
          </div>
        </div>
        <el-collapse v-model="openClips" :key="'rk' + renderKey">
          <el-collapse-item
            v-for="c in rangeClips"
            :key="'clip' + c.name"
            :name="c.name"
            :title="`${c.name}（${c.totalframes}帧，${c.ranges.length} 个攻击盒帧）`"
          >
            <div v-for="r in c.ranges" :key="c.name + '_f' + r.frame" class="range-frame">
              <div class="frame-head">帧 {{ r.frame }}</div>
              <div class="box-grid">
                <div v-for="b in r.box" :key="b.field" class="box-field">
                  <div class="box-label">{{ boxLabels[b.field] || b.field }}</div>
                  <div class="box-xyz">
                    <div v-for="(p, ci) in b.parts" :key="ci" class="box-comp">
                      <span class="axis">{{ 'xyz'[ci] }}</span>
                      <el-input-number
                        v-model="p.value"
                        size="small"
                        :controls="false"
                        :step="0.1"
                        :precision="3"
                        @change="onBoxChange(b, ci)"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </el-collapse-item>
        </el-collapse>
        <div class="no-skill-hint" v-if="!rangeClips.length">未检测到攻击判定盒（范围）。</div>
      </section>

      <!-- ===== 取消规则（CancelActionArg） ===== -->
      <section class="sec">
        <h3 class="sec-title">取消规则（连招衔接）<span class="sec-sub">控制某技能在哪些帧可以"滑动取消"接其他技能</span></h3>
        <div class="bulk-bar">
          <el-button size="small" type="warning" @click="quickTwoWayAB" :disabled="!cancelClipsWith.length">
            🎯 一键一二互滑：所有技能段都加 vKey=101+105
          </el-button>
          <el-button size="small" @click="quickAddVkey(101)" :disabled="!cancelClipsWith.length">全部加一技能(101)</el-button>
          <el-button size="small" @click="quickAddVkey(105)" :disabled="!cancelClipsWith.length">全部加二技能(105)</el-button>
          <el-button size="small" @click="quickRemoveVkey(101)" :disabled="!cancelClipsWith.length">全部移除(101)</el-button>
          <el-button size="small" @click="quickRemoveVkey(105)" :disabled="!cancelClipsWith.length">全部移除(105)</el-button>
        </div>
        <el-collapse v-model="openCancelClips" :key="'ck' + renderKey">
          <el-collapse-item
            v-for="cc in cancelClipsWith"
            :key="'cc' + cc.name"
            :name="cc.name"
            :title="`${cc.name}（${cc.totalframes}帧，${cc.rules.length} 帧含取消规则）`"
          >
            <div v-for="(r, ri) in cc.rules" :key="cc.name + '_f' + r.frame" class="cancel-frame">
              <div class="frame-head">
                <span>帧 {{ r.frame }}</span>
                <span v-if="ri > 0" class="cancel-clear-tag" title="此帧之后的取消规则为追加，不自动清空上一帧">追加</span>
                <span v-else class="cancel-clear-tag is-clear" :title="r.list[0]?.clear ? '此帧先清空上一帧的取消规则，再应用本组' : '不清空'">
                  {{ r.list[0]?.clear ? '清空+重建' : '不清空' }}
                </span>
              </div>
              <div v-for="(rl, rli) in r.list" :key="cc.name + r.frame + 'r' + rli" class="cancel-rule">
                <div v-if="r.list.length > 1" class="rule-group-tag">规则组 {{ rli + 1 }}</div>
                <div class="vkey-chip-row">
                  <div
                    v-for="g in rl.groups"
                    :key="g.vKey + '_' + rli + '_' + cc.name + r.frame"
                    class="vkey-chip"
                    :class="{ active: isKnownVkey(g.vKey) }"
                    :title="vkeyLabel(g.vKey)"
                  >
                    <span class="chip-label">{{ vkeyLabel(g.vKey) }}</span>
                    <el-select
                      v-model="g.vKey"
                      size="small"
                      class="chip-vkey"
                      @change="onVkeyChanged(rl, g)"
                    >
                      <el-option :value="100" label="100 普攻" />
                      <el-option :value="101" label="101 一技能" />
                      <el-option :value="102" label="102 三技能" />
                      <el-option :value="103" label="103 四技能" />
                      <el-option :value="104" label="104 五技能" />
                      <el-option :value="105" label="105 二技能" />
                      <el-option :value="107" label="107 奥义" />
                    </el-select>
                    <button class="chip-del" title="移除此按键" @click="onRemoveVkey(rl, g.vKey)">×</button>
                  </div>
                  <el-button size="small" plain @click="onAddVkey(rl, 101)">+ 一技能</el-button>
                  <el-button size="small" plain @click="onAddVkey(rl, 105)">+ 二技能</el-button>
                </div>
              </div>
            </div>
          </el-collapse-item>
        </el-collapse>
        <div class="no-skill-hint" v-if="!cancelClipsWith.length">未检测到 CancelActionArg（无取消规则）。</div>
      </section>

      <!-- ===== 位移参数（突进/速度 vx, vy, fRate） ===== -->
      <section class="sec">
        <h3 class="sec-title">位移 / 突进参数<span class="sec-sub">调整动作的 vx（水平速度）、vy（垂直速度）、fRate（前向倍率）</span></h3>
        <div class="bulk-bar">
          <span class="rt-label">突进倍率</span>
          <el-input-number v-model="moveMult" :min="0.1" :max="20" :step="0.1" :precision="2" size="small" class="rt-mult" />
          <el-checkbox v-model="scaleVx" size="small">水平 vx</el-checkbox>
          <el-checkbox v-model="scaleVy" size="small">垂直 vy</el-checkbox>
          <el-checkbox v-model="scaleFRate" size="small">倍率 fRate</el-checkbox>
          <el-button size="small" type="primary" @click="applyMoveScale" :disabled="!moveAffectedCount">应用倍率</el-button>
          <span class="rt-count">将影响 {{ moveAffectedCount }} 条位移参数</span>
        </div>
        <el-collapse v-model="openMoveClips" :key="'mk' + renderKey">
          <el-collapse-item
            v-for="mc in moveClipsWith"
            :key="'mc' + mc.name"
            :name="mc.name"
            :title="`${mc.name}（${mc.totalframes}帧，${mc.moves.length} 帧含位移）`"
          >
            <div v-for="m in mc.moves" :key="mc.name + '_f' + m.frame" class="move-frame">
              <div class="frame-head">帧 {{ m.frame }}</div>
              <div v-for="(ma, mai) in m.list" :key="mc.name + m.frame + 'm' + mai" class="move-arg">
                <div class="move-arg-head">
                  <span class="move-type-tag">{{ moveTypeTag(ma) }}</span>
                  <span class="move-name">{{ ma.kfbType }}</span>
                </div>
                <div class="move-grid">
                  <div class="move-col">
                    <label>vx (水平)</label>
                    <el-input-number
                      v-model="ma.vx"
                      size="small"
                      :controls="false"
                      :step="100000000"
                      @change="onMoveChanged(ma)"
                    />
                    <span class="move-dec">{{ fixedToDec(ma.vx) }}x</span>
                  </div>
                  <div class="move-col">
                    <label>vy (垂直)</label>
                    <el-input-number
                      v-model="ma.vy"
                      size="small"
                      :controls="false"
                      :step="100000000"
                      @change="onMoveChanged(ma)"
                    />
                    <span class="move-dec">{{ fixedToDec(ma.vy) }}x</span>
                  </div>
                  <div class="move-col">
                    <label>fRate (倍率)</label>
                    <el-input-number
                      v-model="ma.fRate"
                      size="small"
                      :controls="false"
                      :step="100000000"
                      @change="onMoveChanged(ma)"
                    />
                    <span class="move-dec">{{ fixedToDec(ma.fRate) }}x</span>
                  </div>
                  <div class="move-col face-col">
                    <label>朝向</label>
                    <el-switch
                      v-if="ma.useFace !== undefined"
                      v-model="ma.useFace"
                      size="small"
                      @change="onMoveChanged(ma)"
                    />
                    <span v-else class="move-dec muted">无</span>
                  </div>
                </div>
              </div>
            </div>
          </el-collapse-item>
        </el-collapse>
        <div class="no-skill-hint" v-if="!moveClipsWith.length">未检测到位移参数脚本。</div>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted, useTemplateRef, shallowRef, nextTick } from 'vue';
import {
  buildSkillModel,
  flushBoxField,
  flushCancelGroup,
  flushMoveArg,
  addCancelVkey,
  removeCancelVkey,
  type SkillModel,
  type BoxField,
  type CancelVkeyItem,
  type CancelRule,
  type MoveArg,
} from '@/workers/assetManager/kfb/kfbSkillModel';
import { useAssetManager } from '@/store/assetManager';
import { PreviewType } from '@/types/preview';
import type { PreviewFrameAnimationDetail, FrameAnimationGroup } from '@/types/preview';
import type { AssetInfo } from '@/workers/assetManager';

const props = defineProps<{ sem: any }>();
const emit = defineEmits<{ (e: 'change'): void }>();

const model = ref<SkillModel | null>(null);
const openClips = ref<string[]>([]);

// 范围倍率
const rangeMult = ref(1.5);
const scaleAttack = ref(true);
const scaleWeapon = ref(true);
const scaleHurt = ref(false);
const axisX = ref(true);
const axisY = ref(true);
const axisZ = ref(false);
const enableZeroReplace = ref(false);
const zeroReplaceVal = ref(1);

const AXIS_FLAGS = computed(() => [axisX.value, axisY.value, axisZ.value]);

// 强制 UI 刷新（解决 el-input-number 程序化赋值不刷新问题）
const renderKey = ref(0);
function forceRefresh() { renderKey.value++; }

// clip 勾选状态（默认全选）
const clipChecked = ref<Record<string, boolean>>({});
const clipAllChecked = ref(true);

function rebuildClipChecked() {
  const next: Record<string, boolean> = {};
  for (const c of rangeClips.value) next[c.name] = true;
  clipChecked.value = next;
  clipAllChecked.value = true;
}

function onClipAllChange(val: any) {
  const v = !!val;
  for (const c of rangeClips.value) clipChecked.value[c.name] = v;
  clipAllChecked.value = v;
}

function onClipCheckChange() {
  const vals = rangeClips.value.map((c) => clipChecked.value[c.name]);
  clipAllChecked.value = vals.every(Boolean);
}

const SIZE_FIELD_MAP: Record<string, string[]> = {
  attack: ['attack_size'],
  weapon: ['weapon_size'],
  hurt: ['hurt_size0', 'hurt_size1', 'hurt_size2'],
};

const selectedSizeFields = computed(() => {
  const targets: string[] = [];
  if (scaleAttack.value) targets.push(...SIZE_FIELD_MAP.attack);
  if (scaleWeapon.value) targets.push(...SIZE_FIELD_MAP.weapon);
  if (scaleHurt.value) targets.push(...SIZE_FIELD_MAP.hurt);
  return targets;
});

const affectedCount = computed(() => {
  if (!model.value) return 0;
  const targets = selectedSizeFields.value;
  let n = 0;
  for (const clip of model.value.clips) {
    if (!clipChecked.value[clip.name]) continue;
    for (const r of clip.ranges)
      for (const b of r.box)
        if (targets.includes(b.field)) n++;
  }
  return n;
});

function applyRangeScale() {
  if (!model.value) return;
  const targets = selectedSizeFields.value;
  const mult = rangeMult.value;
  const axes = AXIS_FLAGS.value;
  const zRep = enableZeroReplace.value;
  const zVal = zeroReplaceVal.value;
  const NEAR_ZERO = 0.001;
  for (const clip of model.value.clips) {
    if (!clipChecked.value[clip.name]) continue;
    for (const r of clip.ranges)
      for (const b of r.box) {
        if (!targets.includes(b.field)) continue;
        let changed = false;
        for (let i = 0; i < b.parts.length; i++) {
          if (!axes[i]) continue;
          let v = b.parts[i].value;
          if (Math.abs(v) < NEAR_ZERO && zRep) v = zVal;
          if (Math.abs(v) < NEAR_ZERO) continue;
          const nv = Math.round(v * mult * 1000) / 1000;
          // 用整对象替换触发 el-input-number 响应
          b.parts[i] = { text: b.parts[i].text, value: nv, edited: true };
          changed = true;
        }
        if (changed) flushBoxField(b);
      }
  }
  // 强制刷新
  forceRefresh();
  emit('change');
}

const boxLabels: Record<string, string> = {
  attack_pos: '攻击判定位置', attack_size: '攻击判定大小',
  weapon_pos: '武器判定位置', weapon_size: '武器判定大小',
  hurt_pos0: '受击框0位置', hurt_size0: '受击框0大小',
  hurt_pos1: '受击框1位置', hurt_size1: '受击框1大小',
  hurt_pos2: '受击框2位置', hurt_size2: '受击框2大小',
};

// ===== 一键批量操作 =====
function bulkSetCD(on: boolean) {
  if (!model.value) return;
  for (const g of model.value.skills)
    for (const e of g.cd) e.ref.enabelSetCD = on;
  forceRefresh();
  emit('change');
}
function bulkSetIgnoreCD(on: boolean) {
  if (!model.value) return;
  for (const g of model.value.skills)
    for (const e of g.cd) e.ref.isIgnoreCD = on;
  forceRefresh();
  emit('change');
}
function bulkSetEnable(on: boolean) {
  if (!model.value) return;
  for (const g of model.value.skills)
    for (const e of g.cd) {
      e.ref.enableSetEnable = on;
      e.ref.isEnable = on;
    }
  forceRefresh();
  emit('change');
}
function bulkSetRecordCD(on: boolean) {
  if (!model.value) return;
  for (const g of model.value.skills)
    for (const ic of g.icons) ic.ref.IsRecordSkillCD = on;
  forceRefresh();
  emit('change');
}

// 只展示含攻击盒的片段，按名称排序，技能片段靠前
const rangeClips = computed(() =>
  (model.value?.clips ?? [])
    .filter((c) => c.ranges.length > 0)
    .sort((a, b) => {
      const ak = /^skill/i.test(a.name) ? 0 : 1;
      const bk = /^skill/i.test(b.name) ? 0 : 1;
      return ak - bk || a.name.localeCompare(b.name);
    }),
);

function rebuild() {
  if (!props.sem) {
    model.value = null;
    return;
  }
  model.value = buildSkillModel(props.sem);
  // 默认展开前几个技能片段
  openClips.value = (model.value.clips.filter((c) => /^skill/i.test(c.name)).map((c) => c.name)).slice(0, 3);
  rebuildClipChecked();
}

watch(
  () => props.sem,
  () => rebuild(),
  { immediate: true },
);

/** 范围分量被编辑：标记并立即写回 sem（单位 米 → 定点），再通知父组件产生修改 */
function onBoxChange(b: BoxField, ci: number) {
  b.parts[ci].edited = true;
  flushBoxField(b);
  emit('change');
}

/** CD/EP/图标控件统一变更入口：通知父组件启用「应用修改」 */
function onAnyChange() {
  emit('change');
}

// ─────────────── 脚本注入工具栏 ───────────────

type InjType = 'banner' | 'permanentBanner' | 'damage' | 'jump' | 'summon' | 'invincible' | 'dialog' | 'acceptVkey';

const injClipIdx = ref(0);
const injFrame = ref(0);
const injType = ref<InjType>('banner');
const injP = ref({
  title: '',
  content: '',
  autoClose: 120,
  rate: 99999,
  objFrame: 0,
  targetFrame: 0,
  assetId: '',
  isAoyi: true,
  dir: 0,
  on: true,
  text: '',
  auto: true,
  // 常驻横幅 (20300) — DoLuaCommonScriptArg.ShowPlotGuideTips
  strFuncName: 'ShowPlotGuideTips',
  // lstArgs[2] 为正文，默认留空让用户输入要显示的内容
  pbArgs: ['2', 'true', '', '0,220,0', 'false', '1', '1', '1', '0', '2@'],
  // 接招派生 (1007) — AcceptVKeyArg
  vkeyType: 1011,
  vkeyValue: 101,
  effectDictKey: '9005922',
});
const injWarn = ref('');
const injOk = ref('');

/** 所有动作片段（不限是否含攻击盒） */
const allClips = computed(() => {
  const list = props.sem?.clipsDataList;
  return Array.isArray(list) ? list : [];
});

/** 帧下拉选项：标注每帧是否已有脚本壳 / 是否纯盒帧 / 是否空帧 */
const frameOptions = computed(() => {
  const clip = allClips.value[injClipIdx.value];
  if (!clip) return [];
  const total = Number(clip.totalframes) || 0;
  const kf = clip.keyframes || {};
  const opts: { idx: number; tag: string; cls: string }[] = [];
  for (let i = 0; i < total; i++) {
    const fr = kf[String(i)];
    let tag = '空帧';
    let cls = 'empty';
    if (fr) {
      if (fr.frameData) {
        tag = '有脚本壳';
        cls = 'shell';
      } else if (Number(fr.eventType) === -1) {
        tag = '纯盒帧(-1)';
        cls = 'box';
      } else {
        tag = '无脚本壳';
        cls = 'noshell';
      }
    }
    opts.push({ idx: i, tag, cls });
  }
  return opts;
});

watch(injClipIdx, () => {
  injFrame.value = 0;
  injWarn.value = '';
  injOk.value = '';
});
watch([injType, injFrame], () => {
  injWarn.value = '';
  injOk.value = '';
});

/** 取到目标帧对象，不存在则按 AnimationFrame($tid=6) 模板新建 */
function ensureFrame(clip: any, idx: number): any {
  if (!clip.keyframes) clip.keyframes = {};
  const key = String(idx);
  let fr = clip.keyframes[key];
  if (!fr) {
    fr = { $tid: 6, index: idx, eventType: 0 };
    clip.keyframes[key] = fr;
  }
  return fr;
}

/** 确保帧带有 KHFrameData($tid=3) 脚本壳；返回是否新建壳 / 是否改了 etype */
function ensureFrameData(fr: any): { created: boolean; etypeChanged: boolean } {
  let created = false;
  let etypeChanged = false;
  if (!fr.frameData) {
    fr.frameData = {
      $tid: 3,
      index: 0,
      once: false,
      scriptDatas: [],
      scriptDatasForSounds: [],
      scriptDatasForEffects: [],
    };
    created = true;
  }
  if (!Array.isArray(fr.frameData.scriptDatas)) fr.frameData.scriptDatas = [];
  // etype=-1 纯盒帧没有事件壳，注入脚本会被编码过滤，需转成普通帧(0)
  if (Number(fr.eventType) === -1) {
    fr.eventType = 0;
    etypeChanged = true;
  }
  return { created, etypeChanged };
}

/** 按 schema default_json 模板构造各类型脚本对象（$tid 与 FScalar 字符串格式均已核对） */
function buildScript(): any {
  const p = injP.value;
  switch (injType.value) {
    case 'banner':
      // KH.SimpleDialogArg ($tid=617, scriptType=20083)
      return {
        $tid: 617,
        scriptType: 20083,
        argInt: 0,
        argStr: '',
        IsDestroy: false,
        IsHide: false,
        Title: p.title || '',
        Content: p.content || '',
        ImgID: 0,
        X: 0,
        Y: 0,
        autoCloseFrameCount: p.autoClose || 0,
        UIAlignMode: 0,
        OffsetX: 0,
        OffsetY: 0,
      };
    case 'permanentBanner':
      // KH.DoLuaCommonScriptArg ($tid=470, scriptType=20300)
      // 通过 Lua 函数 ShowPlotGuideTips 实现常驻横幅，参数走 lstArgs 字符串列表
      return {
        $tid: 470,
        scriptType: 20300,
        argInt: 0,
        argStr: '',
        strFuncName: p.strFuncName || 'ShowPlotGuideTips',
        iArgsNum: p.pbArgs?.length || 0,
        lstArgs: Array.isArray(p.pbArgs) ? p.pbArgs.slice() : [],
      };
    case 'damage':
      // KH.TSHitTestArg ($tid=16, scriptType=1013)
      return {
        $tid: 16,
        scriptType: 1013,
        argInt: 0,
        argStr: '',
        isModifySkillOffset: false,
        skillIndex: 0,
        isPrecisionHit: false,
        enablePowerLie: false,
        powerXLie: '0',
        powerYLie: '0',
        enableSelfCondition: false,
        selfCondType: 0,
        enableAimCondition: false,
        aimCondType: 0,
        enableForceRebound: false,
        forceReBoundPowX: '0',
        forceReBoundPowY: '0',
        enableHpEnhance: false,
        enemyHpEnhanceThreshold: '0',
        enemyHpEnhanceRate: '0',
        selfHpEnhanceThreshold: '0',
        selfHpEnhanceRate: '0',
        enableBlackHp: false,
        damageToBlackHpRatio: '0',
        enableSpecialEnhance: true,
        specialEnhanceAtkRate: {
          $tid: 14,
          AssignStyle: 1,
          ValueInfo: { $tid: 15, Value: p.rate || 99999 },
        },
        enableHitCount: false,
        IgnoreHurtGoTest: false,
        hurtBuffIdStr: '',
        objectFrameIndex: p.objFrame ?? injFrame.value,
      };
    case 'jump':
      // 基础 KHScriptData ($tid=8, scriptType=1031) 帧跳转
      return { $tid: 8, scriptType: 1031, argInt: p.targetFrame || 0, argStr: '' };
    case 'summon':
      // KH.CreateInteractArg ($tid=19, scriptType=10001)
      return {
        $tid: 19,
        scriptType: 10001,
        argInt: 0,
        argStr: '',
        id: 0,
        assetId: p.assetId || '',
        autoSpliceAvatarId: false,
        avatarId: 0,
        bindSkillID: 0,
        fromActor: false,
        autoPvpSkill: false,
        useScenePos: false,
        useBlackBoardPos: false,
        offsetX: '0',
        offsetY: '0',
        offsetZ: '0',
        groupID: 0,
        dir: p.dir || 0,
        delayFrames: 0,
        lifeFrames: 0,
        rotation: '0',
        rRotation: '0',
        followTarget: false,
        followType: 0,
        followChildName: '',
        cancelFollowTarget: false,
        disappearType: 0,
        weaponArgID: 0,
        skillOffset: 0,
        isAoyi: !!p.isAoyi,
        destroySameChild: false,
        accDmg: 0,
        accPrecent: '4294967296',
        accValue: 0,
        applyTag: false,
        tagType: 0,
        reflectionSpeed: '0',
        offSetX: '0',
        member_OffsetX: '0',
        changeFollowType: false,
        emitAngle: 0,
        emitAngleRange: 0,
        isExistWhenSwitchScene: false,
        followSourceFreeze: false,
      };
    case 'invincible':
      // 基础 KHScriptData ($tid=8, scriptType=1056) 无敌帧开关
      return { $tid: 8, scriptType: 1056, argInt: p.on ? 1 : 0, argStr: '' };
    case 'acceptVkey':
      // KH.AcceptVKeyArg ($tid=17, scriptType=1007) 接招派生
      return {
        $tid: 17,
        scriptType: 1007,
        argInt: p.vkeyType ?? 1011,
        argStr: p.effectDictKey || '9005922',
        clear: true,
        checkUp: false,
        limitFrames: 6,
        limitMapY: '0',
        limitStep: 0,
        vkeys: [[p.vkeyValue ?? 101]],
        checkNow: true,
        checkParent: false,
        upDownMinOffset: '1717986918',
        checkIsInCD: false,
        checkIsSealed: false,
      };
    case 'dialog':
      // KH.ShowPlotDuihuaArg ($tid=609, scriptType=10024)
      return {
        $tid: 609,
        scriptType: 10024,
        argInt: 0,
        argStr: '',
        auto: !!p.auto,
        title: p.title || '',
        text: p.text || '',
        depth: 110,
        useCfg: false,
        actorID: 0,
        duihuaID: 0,
        charsPerSecond: 0,
      };
  }
}

function scriptTypeLabel(t: InjType): string {
  return (
    {
      banner: '横幅播报',
      permanentBanner: '常驻横幅',
      damage: '全局增伤',
      jump: '帧跳转',
      summon: '召唤物',
      invincible: '无敌帧',
      dialog: '剧情对话',
      acceptVkey: '接招派生',
    } as Record<InjType, string>
  )[t];
}

function injectScript() {
  injWarn.value = '';
  injOk.value = '';
  const clip = allClips.value[injClipIdx.value];
  if (!clip) {
    injWarn.value = '请先选择目标片段';
    return;
  }
  const idx = Number(injFrame.value);
  if (!Number.isFinite(idx) || idx < 0) {
    injWarn.value = '帧索引无效';
    return;
  }
  if (injType.value === 'summon' && !injP.value.assetId.trim()) {
    injWarn.value = '召唤物必须填写 assetId（如 90059401）';
    return;
  }

  const fr = ensureFrame(clip, idx);
  const { created, etypeChanged } = ensureFrameData(fr);
  const script = buildScript();
  fr.frameData.scriptDatas.push(script);

  const notes: string[] = [];
  if (created) notes.push('已新建脚本壳');
  if (etypeChanged) notes.push('etype -1→0');
  const noteStr = notes.length ? `（${notes.join('，')}）` : '';
  injOk.value = `✅ 已注入「${scriptTypeLabel(injType.value)}」到 ${clip.name || '片段'} 帧${idx}${noteStr}，共 ${fr.frameData.scriptDatas.length} 个脚本`;

  forceRefresh();
  emit('change');
}

// ===== 帧动画联动预览 =====
const assetStore = useAssetManager();
const faFileInput = useTemplateRef<HTMLInputElement>('faFileInput');

const faInfo = shallowRef<AssetInfo | null>(null);
const faDetail = computed<PreviewFrameAnimationDetail | null>(() => {
  const p = faInfo.value?.preview as any;
  return p?.type === PreviewType.FrameAnimation ? (p as PreviewFrameAnimationDetail) : null;
});
const faGroups = computed<FrameAnimationGroup[]>(() => faDetail.value?.groups ?? []);

const faBinding = ref<string>('');
const faAutoMatched = ref(false);
const faCurrentFrame = ref(0);
const faPlaying = ref(false);
const faFps = ref(12);
const faLoop = ref(true);
const faImageData = ref<string | null>(null);
const faImporting = ref(false);
const faStatus = ref('');
const faSyncLock = ref(false);

let faAnimId: number | null = null;
let faLastTime = 0;

const faCurrentGroup = computed<FrameAnimationGroup | undefined>(() =>
  faGroups.value.find(g => g.name === faBinding.value),
);
const faTotalFrames = computed(() => faCurrentGroup.value?.frameCount ?? 0);

const SCRIPT_MARKER: Record<number, { cls: string; label: string }> = {
  20083: { cls: 'm-banner', label: '横幅' },
  20300: { cls: 'm-permbanner', label: '常驻横幅' },
  1013: { cls: 'm-damage', label: '增伤' },
  1031: { cls: 'm-jump', label: '跳转' },
  10001: { cls: 'm-summon', label: '召唤' },
  1056: { cls: 'm-invincible', label: '无敌' },
  10024: { cls: 'm-dialog', label: '对话' },
  1007: { cls: 'm-accept', label: '接招' },
};

function kfbToAnimFrame(kfbFrame: number, kfbTotal: number, animTotal: number): number {
  if (animTotal <= 1 || kfbTotal <= 1) return 0;
  return Math.round((kfbFrame * (animTotal - 1)) / (kfbTotal - 1));
}
function animToKfbFrame(animFrame: number, animTotal: number, kfbTotal: number): number {
  if (kfbTotal <= 1 || animTotal <= 1) return 0;
  return Math.round((animFrame * (kfbTotal - 1)) / (animTotal - 1));
}

function autoMatchGroup(clipName: string): string | undefined {
  const names = faGroups.value.map(g => g.name);
  if (names.includes(clipName)) return clipName;
  const base = clipName.replace(/_?\d+$/, '');
  const matches = names.filter(g => g.startsWith(base));
  if (matches.length === 1) return matches[0];
  const lowerBase = base.toLowerCase();
  const ciMatches = names.filter(g => g.toLowerCase().startsWith(lowerBase));
  if (ciMatches.length === 1) return ciMatches[0];
  return undefined;
}

watch(injClipIdx, () => {
  if (!faGroups.value.length) return;
  const clip = allClips.value[injClipIdx.value];
  if (!clip) return;
  const matched = autoMatchGroup(clip.name || '');
  if (matched) {
    faBinding.value = matched;
    faAutoMatched.value = true;
  } else {
    faAutoMatched.value = false;
  }
});

async function onFaFileSelected(e: Event) {
  const input = e.target as HTMLInputElement;
  if (!input.files?.length) return;
  faImporting.value = true;
  faStatus.value = '正在加载帧动画…';
  try {
    const files = Array.from(input.files);
    const infos = await assetStore.loadBundlesAux(files);
    const faAsset = infos.find(i => (i.preview as any)?.type === PreviewType.FrameAnimation);
    if (!faAsset) {
      faStatus.value = `已加载 ${infos.length} 个资产，未发现帧动画图集`;
      return;
    }
    faInfo.value = faAsset;
    faStatus.value = `已加载 ${infos.length} 资产，${faGroups.value.length} 个动画组`;
    const clip = allClips.value[injClipIdx.value];
    if (clip) {
      const matched = autoMatchGroup(clip.name || '');
      if (matched) {
        faBinding.value = matched;
        faAutoMatched.value = true;
      }
    }
  } catch (err) {
    faStatus.value = `加载失败: ${err}`;
  } finally {
    faImporting.value = false;
    input.value = '';
  }
}

async function loadFaFrame(idx: number) {
  const group = faCurrentGroup.value;
  if (!group || !faInfo.value) return;
  const frame = group.frames[idx];
  if (!frame) return;
  try {
    const url = await assetStore.loadPreviewData(faInfo.value, frame.key);
    faImageData.value = url;
  } catch { /* ignore */ }
}

watch(faBinding, () => {
  faStop();
  faCurrentFrame.value = 0;
  loadFaFrame(0);
});

function faTogglePlay() { faPlaying.value ? faStop() : faStart(); }
function faStart() {
  if (faTotalFrames.value < 2) return;
  faPlaying.value = true;
  faLastTime = performance.now();
  faAnimId = requestAnimationFrame(faTick);
}
function faStop() {
  faPlaying.value = false;
  if (faAnimId !== null) { cancelAnimationFrame(faAnimId); faAnimId = null; }
}
function faTick(now: number) {
  if (!faPlaying.value) return;
  const interval = 1000 / faFps.value;
  if (now - faLastTime >= interval) {
    faLastTime = now - ((now - faLastTime) % interval);
    if (faCurrentFrame.value >= faTotalFrames.value - 1) {
      if (faLoop.value) faCurrentFrame.value = 0;
      else { faStop(); return; }
    } else faCurrentFrame.value++;
  }
  faAnimId = requestAnimationFrame(faTick);
}
function faPrev() { faStop(); if (faCurrentFrame.value > 0) faCurrentFrame.value--; }
function faNext() {
  faStop();
  if (faCurrentFrame.value < faTotalFrames.value - 1) faCurrentFrame.value++;
  else if (faLoop.value) faCurrentFrame.value = 0;
}
function faGoToFrame(idx: number) {
  faStop();
  faCurrentFrame.value = Math.max(0, Math.min(idx, faTotalFrames.value - 1));
}

watch(faCurrentFrame, (idx) => {
  loadFaFrame(idx);
  if (faSyncLock.value) return;
  const clip = allClips.value[injClipIdx.value];
  if (!clip) return;
  const kfbTotal = Number(clip.totalframes) || 0;
  if (kfbTotal > 0 && faTotalFrames.value > 0) {
    faSyncLock.value = true;
    injFrame.value = animToKfbFrame(idx, faTotalFrames.value, kfbTotal);
    nextTick(() => { faSyncLock.value = false; });
  }
});

watch(injFrame, (val) => {
  if (faSyncLock.value) return;
  const clip = allClips.value[injClipIdx.value];
  if (!clip) return;
  const kfbTotal = Number(clip.totalframes) || 0;
  if (kfbTotal > 0 && faTotalFrames.value > 0) {
    faSyncLock.value = true;
    faGoToFrame(kfbToAnimFrame(Number(val), kfbTotal, faTotalFrames.value));
    nextTick(() => { faSyncLock.value = false; });
  }
});

const faCurrentFrameScripts = computed<{ type: number; label: string; cls: string }[]>(() => {
  renderKey.value; // track injection changes
  const clip = allClips.value[injClipIdx.value];
  if (!clip) return [];
  const kfbTotal = Number(clip.totalframes) || 0;
  if (kfbTotal <= 0 || faTotalFrames.value <= 0) return [];
  const kfbFrame = animToKfbFrame(faCurrentFrame.value, faTotalFrames.value, kfbTotal);
  const fr = clip.keyframes?.[String(kfbFrame)];
  const scripts = fr?.frameData?.scriptDatas ?? [];
  return scripts.map((s: any) => {
    const m = SCRIPT_MARKER[s.scriptType];
    return { type: s.scriptType, label: m?.label ?? `#${s.scriptType}`, cls: m?.cls ?? 'm-other' };
  });
});

const faInjectMarkers = computed(() => {
  renderKey.value; // track injection changes
  const clip = allClips.value[injClipIdx.value];
  if (!clip || !faCurrentGroup.value) return [];
  const kfbTotal = Number(clip.totalframes) || 0;
  const animTotal = faTotalFrames.value;
  if (kfbTotal <= 0 || animTotal <= 0) return [];
  const kfs = clip.keyframes || {};
  const markers: { frame: number; animFrame: number; pos: number; cls: string; label: string }[] = [];
  for (const [k, fr] of Object.entries(kfs)) {
    const scripts = (fr as any)?.frameData?.scriptDatas ?? [];
    if (!scripts.length) continue;
    const kfbFrame = Number(k);
    if (isNaN(kfbFrame)) continue;
    const animFrame = kfbToAnimFrame(kfbFrame, kfbTotal, animTotal);
    const pos = animTotal > 1 ? (animFrame / (animTotal - 1)) * 100 : 0;
    const firstKnown = scripts.find((s: any) => SCRIPT_MARKER[s.scriptType]);
    const m = firstKnown ? SCRIPT_MARKER[(firstKnown as any).scriptType] : null;
    const labels = scripts.map((s: any) => SCRIPT_MARKER[s.scriptType]?.label ?? `#${s.scriptType}`);
    markers.push({ frame: kfbFrame, animFrame, pos, cls: m?.cls ?? 'm-other', label: labels.join('+') });
  }
  return markers;
});

onUnmounted(() => faStop());

// ================== 取消规则（CancelActionArg） ==================

const openCancelClips = ref<string[]>([]);

const cancelClipsWith = computed(() =>
  (model.value?.cancels ?? [])
    .filter((c) => c.rules.length > 0)
    .sort((a, b) => {
      const ak = /^skill/i.test(a.name) ? 0 : 1;
      const bk = /^skill/i.test(b.name) ? 0 : 1;
      return ak - bk || a.name.localeCompare(b.name);
    }),
);

const VKEY_LABELS: Record<number, string> = {
  100: '普攻', 101: '一技能', 102: '三技能', 103: '四技能',
  104: '五技能', 105: '二技能', 107: '奥义',
};
function vkeyLabel(k: number): string { return VKEY_LABELS[k] ?? `vKey=${k}`; }
function isKnownVkey(k: number): boolean { return k in VKEY_LABELS; }

function onVkeyChanged(_rl: CancelRule, g: CancelVkeyItem) {
  flushCancelGroup(g);
  forceRefresh();
  emit('change');
}
function onRemoveVkey(rl: CancelRule, vKey: number) {
  removeCancelVkey(rl, vKey);
  forceRefresh();
  emit('change');
}
function onAddVkey(rl: CancelRule, vKey: number) {
  addCancelVkey(rl, vKey);
  forceRefresh();
  emit('change');
}

/** 一键：所有技能段的所有 CancelActionArg 都加 vKey=101 和 vKey=105 */
function quickTwoWayAB() {
  if (!model.value) return;
  let n = 0;
  for (const cc of model.value.cancels) {
    for (const r of cc.rules) {
      for (const rl of r.list) {
        if (addCancelVkey(rl, 101)) n++;
        if (addCancelVkey(rl, 105)) n++;
      }
    }
  }
  forceRefresh();
  emit('change');
  console.log(`[取消规则] 一键双向互滑：新增 ${n} 个 vKey 条目`);
}

function quickAddVkey(vKey: number) {
  if (!model.value) return;
  let n = 0;
  for (const cc of model.value.cancels) {
    for (const r of cc.rules)
      for (const rl of r.list)
        if (addCancelVkey(rl, vKey)) n++;
  }
  forceRefresh();
  emit('change');
  console.log(`[取消规则] 全部加 vKey=${vKey}：新增 ${n} 条`);
}

function quickRemoveVkey(vKey: number) {
  if (!model.value) return;
  let n = 0;
  for (const cc of model.value.cancels) {
    for (const r of cc.rules)
      for (const rl of r.list)
        if (removeCancelVkey(rl, vKey)) n++;
  }
  forceRefresh();
  emit('change');
  console.log(`[取消规则] 全部移除 vKey=${vKey}：删除 ${n} 条`);
}

// ================== 位移参数（vx/vy/fRate） ==================

const openMoveClips = ref<string[]>([]);
const moveMult = ref(2);
const scaleVx = ref(true);
const scaleVy = ref(false);
const scaleFRate = ref(true);

const FIXED_SCALE_M = 4294967296; // 2^32
function fixedToDec(v: number): string {
  if (v === 0) return '0.00';
  const d = v / FIXED_SCALE_M;
  return d.toFixed(2);
}

const moveClipsWith = computed(() =>
  (model.value?.moves ?? [])
    .filter((c) => c.moves.length > 0)
    .sort((a, b) => {
      const ak = /^skill/i.test(a.name) ? 0 : 1;
      const bk = /^skill/i.test(b.name) ? 0 : 1;
      return ak - bk || a.name.localeCompare(b.name);
    }),
);

const moveAffectedCount = computed(() => {
  if (!model.value) return 0;
  let n = 0;
  for (const mc of model.value.moves) {
    for (const m of mc.moves) {
      for (const ma of m.list) {
        if (scaleVx.value && typeof ma.ref.vx === 'number' && ma.vx !== 0) n++;
        if (scaleVy.value && typeof ma.ref.vy === 'number' && ma.vy !== 0) n++;
        if (scaleFRate.value && typeof ma.ref.fRate === 'number' && ma.fRate !== 0) n++;
      }
    }
  }
  return n;
});

function onMoveChanged(ma: MoveArg) {
  flushMoveArg(ma);
  emit('change');
}

function moveTypeTag(ma: MoveArg): string {
  const parts: string[] = [];
  if (typeof ma.ref.vx === 'number') parts.push('vx');
  if (typeof ma.ref.vy === 'number') parts.push('vy');
  if (typeof ma.ref.fRate === 'number') parts.push('fRate');
  return parts.join('·') || 'move';
}

function applyMoveScale() {
  if (!model.value) return;
  const mult = moveMult.value;
  for (const mc of model.value.moves) {
    for (const m of mc.moves) {
      for (const ma of m.list) {
        let changed = false;
        if (scaleVx.value && typeof ma.ref.vx === 'number' && ma.vx !== 0) {
          // 保留正负号，按倍率缩放
          const sign = ma.vx >= 0 ? 1 : -1;
          const absVal = Math.abs(ma.vx);
          ma.vx = sign * Math.round(absVal * mult);
          changed = true;
        }
        if (scaleVy.value && typeof ma.ref.vy === 'number' && ma.vy !== 0) {
          const sign = ma.vy >= 0 ? 1 : -1;
          const absVal = Math.abs(ma.vy);
          ma.vy = sign * Math.round(absVal * mult);
          changed = true;
        }
        if (scaleFRate.value && typeof ma.ref.fRate === 'number' && ma.fRate !== 0) {
          const sign = ma.fRate >= 0 ? 1 : -1;
          const absVal = Math.abs(ma.fRate);
          ma.fRate = sign * Math.round(absVal * mult);
          changed = true;
        }
        if (changed) flushMoveArg(ma);
      }
    }
  }
  forceRefresh();
  emit('change');
}
</script>

<style scoped>
.kfb-skill-editor {
  height: 100%;
  overflow: auto;
  padding: 4px 2px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.empty {
  color: rgba(255, 255, 255, 0.5);
  padding: 40px;
  text-align: center;
}
.sec-title {
  margin: 0 0 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--el-color-primary);
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.sec-sub {
  font-size: 11px;
  font-weight: 400;
  color: rgba(255, 255, 255, 0.4);
}
.bulk-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
}
.field-help {
  font-size: 11px;
  line-height: 1.7;
  color: rgba(255, 255, 255, 0.5);
  padding: 8px 10px;
  margin-bottom: 8px;
  border: 1px dashed rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.02);
}
.field-help b {
  color: var(--el-color-primary);
  font-weight: 600;
}
.skill-cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.skill-card {
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.03);
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.aid {
  font-weight: 600;
  font-size: 13px;
}
.counts {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
}
.row-head,
.cd-row {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 6px;
  align-items: center;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.55);
}
.cd-row {
  padding: 4px 0;
  border-top: 1px dashed rgba(255, 255, 255, 0.08);
}
.ep-grid,
.icon-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ep-item,
.icon-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  flex-wrap: wrap;
}
.icon-id {
  min-width: 90px;
  font-family: Consolas, Monaco, monospace;
  font-size: 11px;
  color: var(--el-color-warning);
}
.multi-card {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  padding: 8px;
  margin-bottom: 8px;
  background: rgba(255, 255, 255, 0.02);
}
.multi-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  margin-bottom: 6px;
}
.state-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
  flex-wrap: wrap;
  padding: 4px 0;
  border-top: 1px dashed rgba(255, 255, 255, 0.06);
}
.state-idx {
  font-family: Consolas, Monaco, monospace;
  color: var(--el-color-primary);
  min-width: 90px;
}
.acc-hint {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
  margin: 0 0 6px;
}
.acc-grid {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.acc-row {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 12px;
  padding: 3px 0;
  border-top: 1px dashed rgba(255, 255, 255, 0.06);
}
.acc-key {
  font-family: Consolas, Monaco, monospace;
  color: rgba(255, 255, 255, 0.6);
  min-width: 120px;
}
.no-skill-hint {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.4);
}
.range-toolbar {
  padding: 8px 10px;
  margin-bottom: 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
}
.rt-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.rt-row + .rt-row {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed rgba(255, 255, 255, 0.06);
}
.rt-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-color-primary);
}
.rt-mult {
  width: 100px;
}
.rt-zero {
  width: 90px;
}
.rt-count {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
}
.rt-sep {
  color: rgba(255, 255, 255, 0.2);
  margin: 0 2px;
}
.rt-hint {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.35);
}
.clip-table-wrap {
  margin-bottom: 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  overflow: hidden;
}
.clip-table-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.cth-title {
  font-size: 12px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.6);
}
.clip-table {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  padding: 8px 10px;
  max-height: 160px;
  overflow-y: auto;
}
.clip-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.04);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.2s;
}
.clip-chip.off {
  opacity: 0.4;
  border-color: rgba(255, 255, 255, 0.06);
}
.chip-name {
  font-family: Consolas, Monaco, monospace;
  color: rgba(255, 255, 255, 0.75);
}
.chip-cnt {
  font-size: 10px;
  color: var(--el-color-primary);
  background: rgba(255, 255, 255, 0.06);
  border-radius: 3px;
  padding: 0 4px;
}
.range-frame {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  padding: 8px;
  margin-bottom: 8px;
}
.frame-head {
  font-size: 12px;
  font-weight: 600;
  color: var(--el-color-primary);
  margin-bottom: 6px;
}
.box-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px;
}
.box-field {
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.02);
}
.box-label {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.55);
  margin-bottom: 4px;
}
.box-xyz {
  display: flex;
  gap: 6px;
}
.box-comp {
  display: flex;
  align-items: center;
  gap: 3px;
}
.axis {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
  width: 10px;
}
:deep(.el-collapse-item__header) {
  font-size: 12px;
}

/* ── 脚本注入工具栏 ── */
.inject-bar {
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
}
.inj-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.inj-row + .inj-row {
  margin-top: 10px;
}
.inj-label {
  font-size: 12px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.6);
  white-space: nowrap;
}
.inj-clip {
  width: 220px;
}
.inj-frame {
  width: 170px;
}
.inj-type {
  width: 200px;
}
.inj-params {
  padding: 8px 10px;
  border: 1px dashed rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.02);
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
}
.inj-params label {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
  white-space: nowrap;
}
.inj-input {
  width: 130px;
}
.inj-input-wide {
  width: 240px;
}
.inj-num {
  width: 110px;
}
.inj-tip {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.38);
}
/* 常驻横幅 lstArgs 参数网格 */
.pb-args {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 6px;
  width: 100%;
  margin-top: 6px;
}
.pb-arg {
  display: flex;
  align-items: center;
  gap: 4px;
}
.pb-arg-l {
  font-family: Consolas, Monaco, monospace;
  font-size: 11px;
  color: var(--el-color-warning);
  min-width: 22px;
  text-align: right;
}
.pb-arg :deep(.el-input) {
  flex: 1;
}
.inj-action {
  padding-top: 2px;
}
.inj-hint {
  font-size: 12px;
}
.inj-hint.warn {
  color: var(--el-color-warning);
}
.inj-hint.ok {
  color: var(--el-color-success);
}
.fo-idx {
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
}
.frame-tag {
  margin-left: 8px;
  padding: 0 6px;
  border-radius: 3px;
  font-size: 10px;
  line-height: 18px;
}
.frame-tag.shell {
  background: rgba(103, 194, 58, 0.18);
  color: #95d475;
}
.frame-tag.box {
  background: rgba(230, 162, 60, 0.18);
  color: #eebe77;
}
.frame-tag.noshell {
  background: rgba(144, 147, 153, 0.18);
  color: #b1b3b8;
}
.frame-tag.empty {
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.4);
}

/* ── 帧动画联动预览 ── */
.fa-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.fa-binding {
  width: 260px;
}
.fa-badge-auto {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(103, 194, 58, 0.2);
  color: #95d475;
}
.fa-player {
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.2);
  overflow: hidden;
}
.fa-image-wrap {
  position: relative;
  height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.3);
  background-image:
    linear-gradient(45deg, rgba(255,255,255,0.03) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(255,255,255,0.03) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(255,255,255,0.03) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(255,255,255,0.03) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}
.fa-frame-img {
  max-height: 100%;
  max-width: 100%;
  object-fit: contain;
  image-rendering: pixelated;
}
.fa-placeholder {
  color: rgba(255, 255, 255, 0.4);
  font-size: 13px;
}
.fa-script-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(245, 108, 108, 0.85);
  color: #fff;
  font-weight: 600;
}
.fa-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.03);
  border-top: 1px solid rgba(255, 255, 255, 0.06);
}
.fa-slider-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
}
.fa-counter {
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  min-width: 48px;
  text-align: center;
}
.fa-slider-container {
  flex: 1;
  position: relative;
}
.fa-markers {
  position: absolute;
  top: -2px;
  left: 0;
  right: 0;
  height: 4px;
  pointer-events: none;
}
.fa-marker {
  position: absolute;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  transform: translateX(-50%);
  cursor: pointer;
  pointer-events: auto;
  border: 1px solid rgba(0, 0, 0, 0.3);
}
.fa-marker.m-banner { background: #409eff; }
.fa-marker.m-permbanner { background: #ff9800; }
.fa-marker.m-damage { background: #f56c6c; }
.fa-marker.m-jump { background: #67c23a; }
.fa-marker.m-summon { background: #e6a23c; }
.fa-marker.m-invincible { background: #a855f7; }
.fa-marker.m-dialog { background: #06b6d4; }
.fa-marker.m-accept { background: #ec4899; }
.fa-marker.m-other { background: #909399; }

/* ─── 取消规则 ─── */
.cancel-frame {
  padding: 8px 10px;
  margin-bottom: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.02);
}
.cancel-frame .frame-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 6px;
  color: rgba(255, 255, 255, 0.85);
}
.cancel-clear-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 10px;
  background: rgba(103, 194, 58, 0.15);
  color: #67c23a;
  font-weight: 500;
}
.cancel-clear-tag.is-clear {
  background: rgba(64, 158, 255, 0.15);
  color: #409eff;
}
.cancel-rule {
  padding: 4px 0;
  border-top: 1px dashed rgba(255, 255, 255, 0.05);
}
.rule-group-tag {
  font-size: 11px;
  color: var(--el-color-primary-light-3);
  margin: 3px 0 6px;
}
.vkey-chip-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.vkey-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 4px 3px 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.03);
  font-size: 11px;
}
.vkey-chip.active {
  border-color: rgba(64, 158, 255, 0.5);
  background: rgba(64, 158, 255, 0.08);
}
.chip-label {
  font-family: Consolas, Monaco, monospace;
  color: var(--el-color-primary-light-5);
}
.vkey-chip .chip-vkey {
  width: 95px;
}
.vkey-chip :deep(.el-select__wrapper) {
  padding: 0 6px;
  min-height: 22px;
}
.vkey-chip :deep(.el-input__wrapper) {
  padding: 0 6px;
  box-shadow: none;
}
.vkey-chip :deep(.el-input__inner) {
  font-size: 11px;
}
.chip-del {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: none;
  background: rgba(245, 108, 108, 0.15);
  color: #f56c6c;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.chip-del:hover { background: rgba(245, 108, 108, 0.3); }

/* ─── 位移参数 ─── */
.move-frame {
  padding: 8px 10px;
  margin-bottom: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.02);
}
.move-frame .frame-head {
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 6px;
  color: rgba(255, 255, 255, 0.85);
}
.move-arg {
  padding: 6px 0;
  border-top: 1px dashed rgba(255, 255, 255, 0.05);
}
.move-arg-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.move-type-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 10px;
  background: rgba(230, 162, 60, 0.18);
  color: #e6a23c;
  font-weight: 600;
  font-family: Consolas, Monaco, monospace;
}
.move-name {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
  font-family: Consolas, Monaco, monospace;
}
.move-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}
.move-col {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
}
.move-col label {
  color: rgba(255, 255, 255, 0.55);
}
.move-col.face-col {
  justify-content: center;
  align-items: flex-start;
  padding-top: 18px;
}
.move-col :deep(.el-input-number) {
  width: 100%;
}
.move-col :deep(.el-input__wrapper) {
  padding: 0 8px;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.1) inset;
}
.move-col :deep(.el-input__inner) {
  font-size: 11px;
  font-family: Consolas, Monaco, monospace;
}
.move-dec {
  font-size: 10px;
  color: var(--el-color-success-light-4);
  font-family: Consolas, Monaco, monospace;
}
.move-dec.muted {
  color: rgba(255, 255, 255, 0.3);
}
</style>