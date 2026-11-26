const messages={
  voice_unconfigured:'本地语音环境尚未配置。需要准备模型和运行环境后再启动。',
  voice_preferences_required:'请先保存支持的识别、合成后端和音色。',
  voice_session_required:'请先选择并保存一个已有 DSH 会话。',
  active_identity_required:'尚无已确认的设备配对。请先完成配对。',
  reconcile_required:'配对写入结果仍待核对，暂时不能启动语音服务。',
  host_busy:'配对或运行服务正在使用身份记录，请先结束已有操作。',
  host_unconfigured:'配对环境尚未准备，请先完成环境设置。',
  voice_device_missing:'服务已启动。请在 Sion 的 DSH.AGENT 中连接后再接通会话。',
  voice_restart_required:'偏好已改变。请关闭服务后重新启动，再接通所选会话。',
  voice_busy:'运行操作尚未结束，可以停止或关闭服务。',
  voice_release_unconfirmed:'Host 已尝试清理，但未确认设备已停止。请检查 Sion，不能视为已归还设备资源。',
  voice_identity_lost:'配对身份锁已丢失，服务已停止。请检查配对状态。',
  voice_cancelled:'操作已取消，请刷新状态确认清理结果。',
  voice_environment_required:'语音环境还不完整。请关闭服务后检查依赖和模型。',
  voice_preview_preferences:'请为试听选择有效的语言、音色和语速。',
  voice_preview_failed:'试听生成失败。请检查本地语音环境后重试。',
  voice_address_unavailable:'配对时使用的地址已不在这台 Mac 上。请接回原网络，或在配对页选择当前地址后更新设备配对。',
  voice_lan_address_required:'当前配对没有局域网地址。可选择 USB，或在设备配对中添加局域网地址。',
  voice_port_in_use:'已配对的语音端口正在被占用。请关闭占用该端口的服务，或选择新端口后更新设备配对。',
  voice_usb_port_required:'请选择并保存 Sion 的 USB 串口。',
  voice_usb_port_unavailable:'保存的 USB 串口当前不可用。请检查数据线，重新查找并保存端口。',
  voice_usb_identity_mismatch:'无法确认这个串口连着已配对的 Sion。请检查底座数据线，重新查找并选择 Sion 的端口。',
  voice_usb_open_failed:'无法打开 USB 串口。请关闭占用串口的程序，或检查插件专用环境。',
  voice_usb_access_disabled:'当前配对环境未允许 USB 音频。请准备插件专用环境，或检查安装方的设备访问配置。',
  voice_usb_handshake_failed:'USB 握手未确认。请先在 Sion 的 DSH.AGENT 中点 USB，核对配对后再接通。',
  voice_local_audio_start_failed:'已连到 Sion，但 Mac 的本地语音进程启动失败。请检查语音环境。',
  voice_device_audio_start_failed:'已连到 Sion，但设备未确认开始收音。请查看 Sion 的麦克风状态。',
  voice_device_link_lost:'已经认证 Sion，连接在开始收音前断开。',
  voice_selected_session_unavailable:'已连到 Sion，但 DSH 无法读取所选会话。请在 DSH 打开或核对该会话。',
  voice_usb_standby_interrupted:'USB 连接已断开，待命已结束。请确认 Sion 在 DSH.AGENT 中，再开启 USB 待命。',
  voice_input_overloaded:'最近几次收音跟不上，当前对话已停止。可以重新在 Sion 上开始。',
  voice_relay_config_missing:'当前 DSH 配置档缺少 .stackchan-relay.json，请先准备 Mac 的私有中继配置。',
  voice_relay_config_invalid:'Mac 中继配置无法读取。请检查格式和文件权限。',
  voice_relay_identity_mismatch:'中继配置属于另一份设备配对。请更新本机配置后重新启动服务。',
  voice_relay_timeout:'中继未等到设备。请检查 Sion 的网络和中继模式后重试。',
  voice_relay_unavailable:'无法接入中继。请检查 Mac 的网络、中继证书及 Host 凭据。',
  voice_relay_handshake_failed:'中继上的设备身份未通过验证。请核对两端的配对。',
  voice_caption_required:'仅字幕需要 Sion 的 Text 显示模式。请在 Sion 选择 Text 后重新连接。',
  voice_caption_delivery_failed:'发往 Sion 的字幕未确认入队。完整回复可以在所选 DSH 会话查看。',
  voice_environment_failed:'语音环境检查未完成，请检查本地安装。',
  voice_installation_python_required:'未找到可用的 Apple 芯片版 Python 3.11。请按安装指引补齐，再检查安装条件。',
  voice_installation_tools_required:'缺少 Apple 命令行开发工具。请按安装指引补齐，再检查安装条件。',
  voice_installation_platform_unsupported:'自动准备目前支持 Apple 芯片的 Mac。',
  voice_installation_profile_required:'当前宿主没有提供配置档目录，无法准备专用语音环境。',
  voice_installation_busy:'另一个安装操作正在运行，请等待它结束。',
  voice_installation_storage_invalid:'安装记录或文件校验失败。请检查私有安装目录，现有记录不会自动清除。',
  voice_installation_outdated:'安装记录与当前插件版本不匹配，请显式修复语音环境。',
  voice_installation_selftest_failed:'候选环境未通过离线自检，未替换原有活动环境。',
  voice_installation_source_invalid:'源码归档校验未通过，安装已停止。',
  voice_installation_failed:'语音环境准备未完成。请检查网络、磁盘和安装日志，再重试。',
  voice_installation_cancelled:'安装已取消。请检查当前环境；已发布的环境仍会保留。',
  voice_installation_cleanup_unconfirmed:'安装进程退出尚未确认，请检查本地安装进程。',
  voice_installation_custom:'当前使用自定义语音环境，请在 Host 安装配置中维护它。',
};
export const voiceErrorMessage=code=>messages[code]||'操作需要检查，请查看安装状态和本地日志。';
export class VoiceController {
  #remote;#closed=false;#request;#poll;#generation=0;#snapshotVersion=0;#watching=false;#timer;#listeners=new Set();
  #state={snapshot:null,environment:null,environmentError:'',preview:null,previewError:'',busy:false,action:'',error:''};
  constructor(remote){this.#remote=remote;}
  getSnapshot=()=>this.#state;
  subscribe=fn=>{this.#listeners.add(fn);return()=>this.#listeners.delete(fn);};
  #publish(patch){if(this.#closed)return;this.#state={...this.#state,...patch};for(const fn of this.#listeners)fn();}
  async #refresh(){
    if(this.#closed||this.#poll)return;
    const abort=new AbortController();this.#poll=abort;
    const gen=this.#generation,version=this.#snapshotVersion;
    try{
      const result=await this.#remote.execute('snapshot',abort.signal);
      if(abort.signal.aborted||this.#closed||gen!==this.#generation||version!==this.#snapshotVersion)return;
      if(result.ok)this.#publish({snapshot:result.value});
      else if(!this.#state.busy)this.#publish({error:'无法读取运行状态，请检查连接和访问权限。'});
    }catch{if(!abort.signal.aborted&&!this.#closed&&gen===this.#generation&&!this.#state.busy)this.#publish({error:'运行状态刷新失败，请检查连接。'});}
    finally{if(this.#poll===abort)this.#poll=null;}
  }
  watch(){
    if(this.#watching||this.#closed)return ()=>{};
    this.#watching=true;
    const poll=async()=>{
      if(!this.#watching||this.#closed)return;
      await this.#refresh();
      if(this.#watching&&!this.#closed)this.#timer=setTimeout(poll,2000);
    };
    void poll();
    return ()=>{this.#watching=false;clearTimeout(this.#timer);this.#poll?.abort();};
  }
  async run(action,request){
    if(action==='snapshot')return this.#refresh();
    if(this.#closed||this.#state.busy&&!['stop','shutdown'].includes(action))return;
    this.#poll?.abort();this.#poll=null;
    this.#request?.abort();const abort=new AbortController();this.#request=abort;const gen=++this.#generation;
    const previewAction=action==='preview';
    const environmentAction={'inspect-environment':'inspect','test-environment':'verify'}[action];
    this.#publish({busy:true,action,error:'',preview:null,previewError:'',
      ...(environmentAction||['prepare-environment','repair-environment'].includes(action)?{environment:null,environmentError:''}:{})});
    const publishError=error=>this.#publish(previewAction?{previewError:error}:environmentAction?{environmentError:error}:{error});
    try{
      const result=await (previewAction?this.#remote.preview(request.language,request.voice,request.speechRate,abort.signal)
        :environmentAction?this.#remote.environment(environmentAction,abort.signal):this.#remote.execute(action,abort.signal));
      if(abort.signal.aborted||gen!==this.#generation||this.#closed)return;
      if(result.ok&&previewAction)this.#publish({preview:{sample:result.value,preferences:JSON.stringify(request)}});
      else if(result.ok&&environmentAction)this.#publish({environment:result.value});
      else if(result.ok){++this.#snapshotVersion;this.#publish({snapshot:result.value,error:result.value.lastError?messages[result.value.lastError]||'运行状态需要检查。请停止并检查设备及本地环境。':''});}
      else publishError(result.error.code==='stackchan/owner-required'||result.error.code==='remote-access/denied'
        ?'只有 DSH 所有者可以控制语音服务。'
        :messages[result.error.details?.reason]||(previewAction?messages.voice_preview_failed:'操作未确认成功。请刷新状态，检查配对与本地语音环境。'));
    }catch{if(!abort.signal.aborted&&gen===this.#generation)publishError(previewAction?messages.voice_preview_failed:'连接中断。请刷新运行状态；不能据此认定设备已停止。');}
    finally{if(gen===this.#generation){this.#request=null;this.#publish({busy:false,action:''});}}
  }
  cancelPreview(){if(this.#state.action==='preview')this.#request?.abort();}
  dispose(){this.#watching=false;clearTimeout(this.#timer);this.#closed=true;++this.#generation;this.#request?.abort();this.#poll?.abort();this.#listeners.clear();}
}
