/* Workbench-only bounded read broker. No shell, writes, arbitrary argv or RPC. */
#define _DARWIN_C_SOURCE
#include <sys/stat.h>
#include <sys/types.h>
#include <fcntl.h>
#include <dirent.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <limits.h>
#include <errno.h>
#ifdef __APPLE__
#include <sandbox.h>
#endif
#ifndef WB_GIT
#define WB_GIT "/usr/bin/git"
#endif
#define CAP 262144
static void fail(int code){exit(code);}
static int valid(const char *p){if(!p||strlen(p)>1024||p[0]=='/'||strchr(p,'\\'))return 0;const char *s=p;while(*s){const char *end=strchr(s,'/');size_t n=end?(size_t)(end-s):strlen(s);if(!n||(n==1&&s[0]=='.')||(n==2&&s[0]=='.'&&s[1]=='.')||(n==4&&!strncasecmp(s,".git",4)))return 0;for(size_t i=0;i<n;i++)if((unsigned char)s[i]<32||s[i]==127)return 0;if(!end)return 1;s=end+1;if(!*s)return 0;}return 1;}
static int descend(int root,const char *p,int directory){if(!valid(p))fail(11);int fd=dup(root);if(fd<0)fail(12);if(!*p)return fd;char copy[1025];strcpy(copy,p);char *save=NULL,*part=strtok_r(copy,"/",&save);while(part){char *next=strtok_r(NULL,"/",&save);int child=openat(fd,part,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC|((next||directory)?O_DIRECTORY:0));close(fd);if(child<0)fail(errno==EACCES?20:12);fd=child;part=next;}return fd;}
#ifdef __APPLE__
static void quoted(const char *s,char *out,size_t size){size_t at=0;out[at++]='"';for(;*s;s++){if(at+4>=size)fail(18);if((unsigned char)*s<32)fail(18);if(*s=='"'||*s=='\\')out[at++]='\\';out[at++]=*s;}out[at++]='"';out[at]=0;}
static void git_sandbox(const char *root){char r[PATH_MAX*2+4],g[PATH_MAX*2+4],policy[24000];quoted(root,r,sizeof(r));quoted(WB_GIT,g,sizeof(g));int n=snprintf(policy,sizeof(policy),"(version 1)(allow default)(deny network*)(deny file-write* (require-not (literal \"/dev/null\")))(deny process-exec (require-not (literal %s)))(deny file-read-data (require-not (require-any (literal \"/\")(subpath %s)(subpath \"/System/Library\")(subpath \"/System/Volumes/Preboot\")(subpath \"/usr/lib\")(subpath \"/usr/share\")(subpath \"/Applications/Xcode.app/Contents/Developer\")(subpath \"/Library/Developer/CommandLineTools\")(subpath \"/private/var/db/dyld\")(literal \"/dev/null\")(literal \"/dev/urandom\")(literal \"/dev/random\"))))",g,r);if(n<0||n>=(int)sizeof(policy))fail(18);char *error=NULL;if(sandbox_init(policy,0,&error)){if(error)sandbox_free_error(error);fail(18);}}
#endif
int main(int argc,char **argv){if(argc<5||argc>7)fail(10);const char *root=argv[1],*op=argv[4],*path=argc>5?argv[5]:"";if(root[0]!='/'||strlen(root)>=PATH_MAX)fail(10);int fd=open(root,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);struct stat st;if(fd<0||fstat(fd,&st)||!S_ISDIR(st.st_mode))fail(12);char dev[40],ino[40];snprintf(dev,sizeof(dev),"%llu",(unsigned long long)st.st_dev);snprintf(ino,sizeof(ino),"%llu",(unsigned long long)st.st_ino);if(strcmp(dev,argv[2])||strcmp(ino,argv[3]))fail(15);
 if(!strcmp(op,"check")){close(fd);return 0;}
 if(!strcmp(op,"list")){int child=descend(fd,path,1);DIR *dir=fdopendir(child);if(!dir)fail(12);struct dirent *e;char data[200*(NAME_MAX+4)];size_t at=0;int count=0,limited=0;while((e=readdir(dir))){if(!strcmp(e->d_name,".")||!strcmp(e->d_name,"..")||!strcasecmp(e->d_name,".git"))continue;if(++count>200){limited=1;break;}struct stat entry;char kind='x';if(!fstatat(child,e->d_name,&entry,AT_SYMLINK_NOFOLLOW))kind=S_ISLNK(entry.st_mode)?'l':S_ISDIR(entry.st_mode)?'d':S_ISREG(entry.st_mode)?'f':'x';size_t n=strlen(e->d_name);if(at+n+3>sizeof(data))fail(13);data[at++]=kind;data[at++]=0;memcpy(data+at,e->d_name,n+1);at+=n+1;}closedir(dir);printf("%d%c",limited,0);fwrite(data,1,at,stdout);close(fd);return 0;}
 if(!strcmp(op,"file")){int child=descend(fd,path,0);struct stat before,after;if(fstat(child,&before)||!S_ISREG(before.st_mode))fail(14);if(!(before.st_mode&0444))fail(20);if(before.st_size>CAP)fail(13);char bytes[CAP+1];size_t at=0;ssize_t n;while(at<sizeof(bytes)&&(n=read(child,bytes+at,sizeof(bytes)-at))>0)at+=(size_t)n;if(n<0)fail(12);if(at>CAP)fail(13);if(fstat(child,&after)||before.st_size!=after.st_size||before.st_mtime!=after.st_mtime||before.st_ctime!=after.st_ctime||before.st_mtimespec.tv_nsec!=after.st_mtimespec.tv_nsec||before.st_ctimespec.tv_nsec!=after.st_ctimespec.tv_nsec)fail(19);close(child);close(fd);fwrite(bytes,1,at,stdout);return 0;}
 if(strcmp(op,"status")&&strcmp(op,"diff-index")&&strcmp(op,"diff-worktree"))fail(10);
 if(!valid(path)||(argc>6&&!valid(argv[6])))fail(11);int gitfd=openat(fd,".git",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);if(gitfd<0)fail(17);close(gitfd);
 /* A linked-worktree .git file is deliberately unavailable in this first stage. */
 if(fchdir(fd))fail(12);close(fd);
#ifdef __APPLE__
 git_sandbox(root);
#else
 fail(18); /* No weaker unsandboxed Git fallback. */
#endif
 char *args[60];int a=0;args[a++]=WB_GIT;args[a++]="--no-pager";args[a++]="--no-optional-locks";args[a++]="--literal-pathspecs";args[a++]="--git-dir=.git";args[a++]="--work-tree=.";
 const char *config[]={"core.fsmonitor=false","core.hooksPath=/dev/null","submodule.recurse=false","core.excludesFile=/dev/null","diff.external=","core.pager=cat","core.untrackedCache=false","core.preloadIndex=false",NULL};for(int i=0;config[i];i++){args[a++]="-c";args[a++]=(char*)config[i];}
 if(!strcmp(op,"status")){args[a++]="status";args[a++]="--porcelain=v1";args[a++]="-z";args[a++]="--untracked-files=normal";args[a++]="--ignore-submodules=all";}else{if(!*path)fail(11);args[a++]="diff";if(!strcmp(op,"diff-index"))args[a++]="--cached";args[a++]="--no-ext-diff";args[a++]="--no-textconv";args[a++]="--no-renames";args[a++]="--ignore-submodules=all";args[a++]="--no-color";args[a++]="--";args[a++]=(char*)path;if(argc>6&&*argv[6])args[a++]=argv[6];}args[a]=NULL;
 char *env[]={"PATH=/usr/bin:/bin","HOME=/nonexistent","LANG=C","LC_ALL=C","GIT_CONFIG_NOSYSTEM=1","GIT_CONFIG_GLOBAL=/dev/null","GIT_CONFIG_SYSTEM=/dev/null","GIT_ATTR_NOSYSTEM=1","GIT_PAGER=cat","GIT_OPTIONAL_LOCKS=0","GIT_LITERAL_PATHSPECS=1","GIT_TERMINAL_PROMPT=0",NULL};execve(WB_GIT,args,env);fail(126);return 126;
}
