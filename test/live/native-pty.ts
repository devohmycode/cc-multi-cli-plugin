// Python stdlib terminal shared by the native permission integration checks.
export const pty = String.raw`import os,pty,select,sys,fcntl,termios,struct,signal
pid,fd=pty.fork()
if pid==0: os.execvp(sys.argv[1],sys.argv[1:])
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',36,140,0,0))
def stop(*args):
 try: os.kill(pid,signal.SIGTERM)
 except ProcessLookupError: pass
signal.signal(signal.SIGTERM,stop)
try:
 while True:
  ready,_,_=select.select([fd,0],[],[],1)
  if fd in ready:
   try: data=os.read(fd,65536)
   except OSError: break
   if not data: break
   os.write(1,data)
  if 0 in ready:
   data=os.read(0,4096)
   if not data: stop(); break
   os.write(fd,data)
finally:
 stop()
 _,status=os.waitpid(pid,0)
 sys.exit(os.waitstatus_to_exitcode(status))
`;
