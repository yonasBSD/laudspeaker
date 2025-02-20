import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue, tryCatch } from 'bullmq';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { DataSource, Repository } from 'typeorm';
import { Logger } from 'winston';
import { DisconnectFirebaseDTO } from '../accounts/dto/disconnect-firebase.dto';
import { Account } from '../accounts/entities/accounts.entity';
import { AuthHelper } from '../auth/auth.helper';
import { Workspaces } from '../workspaces/entities/workspaces.entity';
import { CreateOrganizationDTO } from './dto/create-ogranization.dto';
import { InviteMemberDTO } from './dto/invite-user.dto';
import { UpdateOrganizationDTO } from './dto/update-organization.dto';
import { OrganizationInvites } from './entities/organization-invites.entity';
import { OrganizationTeam } from './entities/organization-team.entity';
import { Organization } from './entities/organization.entity';
import {
  DEFAULT_PLAN,
  OrganizationPlan,
} from './entities/organization-plan.entity';
import { QueueType } from '../../common/services/queue/types/queue-type';
import { Producer } from '../../common/services/queue/classes/producer';
import {
  ClickHouseTable,
  ClickHouseClient
} from '../../common/services/clickhouse';

@Injectable()
export class OrganizationService {
  constructor(
    private dataSource: DataSource,
    @Inject(WINSTON_MODULE_NEST_PROVIDER)
    private readonly logger: Logger,
    @InjectRepository(Organization)
    public journeysRepository: Repository<Organization>,
    @InjectRepository(Workspaces)
    public workspacesRepository: Repository<Workspaces>,
    @InjectRepository(Organization)
    public organizationRepository: Repository<Organization>,
    @InjectRepository(OrganizationInvites)
    public organizationInvitesRepository: Repository<OrganizationInvites>,
    @InjectRepository(OrganizationTeam)
    public organizationTeamRepository: Repository<OrganizationTeam>,
    @InjectRepository(Account)
    public accountRepository: Repository<Account>,
    @Inject(AuthHelper)
    public readonly authHelper: AuthHelper,
    @Inject(ClickHouseClient)
    private clickhouseClient: ClickHouseClient,
  ) {}

  log(message, method, session, user = 'ANONYMOUS') {
    this.logger.log(
      message,
      JSON.stringify({
        class: OrganizationService.name,
        method: method,
        session: session,
        user: user,
      })
    );
  }
  debug(message, method, session, user = 'ANONYMOUS') {
    this.logger.debug(
      message,
      JSON.stringify({
        class: OrganizationService.name,
        method: method,
        session: session,
        user: user,
      })
    );
  }
  warn(message, method, session, user = 'ANONYMOUS') {
    this.logger.warn(
      message,
      JSON.stringify({
        class: OrganizationService.name,
        method: method,
        session: session,
        user: user,
      })
    );
  }
  error(error, method, session, user = 'ANONYMOUS') {
    this.logger.error(
      error.message,
      error.stack,
      JSON.stringify({
        class: OrganizationService.name,
        method: method,
        session: session,
        cause: error.cause,
        name: error.name,
        user: user,
      })
    );
  }
  verbose(message, method, session, user = 'ANONYMOUS') {
    this.logger.verbose(
      message,
      JSON.stringify({
        class: OrganizationService.name,
        method: method,
        session: session,
        user: user,
      })
    );
  }

  // Will need update on for multiple workspaces and organization management
  public async update(
    account: Account,
    body: UpdateOrganizationDTO,
    session: string
  ) {
    const queryRunner = await this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      await queryRunner.manager.update(
        Organization,
        {
          id: account?.teams?.[0]?.organization.id,
        },
        {
          companyName: body.name,
        }
      );

      await queryRunner.manager.update(
        Workspaces,
        {
          id: account?.teams?.[0]?.organization?.workspaces?.[0]?.id,
        },
        {
          timezoneUTCOffset: body.timezoneUTCOffset,
        }
      );

      await queryRunner.commitTransaction();
    } catch (err) {
      await queryRunner.rollbackTransaction();
      this.error(err, this.update, session, account.id);
      throw new BadRequestException('Error during update');
    } finally {
      await queryRunner.release();
    }
  }

  // Will need update on for multiple workspaces and organization management
  public async create(
    account: Account,
    body: CreateOrganizationDTO,
    session: string
  ) {
    if (account?.teams?.[0]?.organization?.workspaces?.[0]) {
      throw new BadRequestException('You have already setup organization');
    }

    const queryRunner = await this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      const plan = await queryRunner.manager.save(OrganizationPlan, {
        ...DEFAULT_PLAN,
      });

      const organization = await queryRunner.manager.save(Organization, {
        companyName: body.name,
        owner: {
          id: account.id,
        },
        plan: { id: plan.id },
      });

      const workspace = await queryRunner.manager.create(Workspaces, {
        name: organization.companyName + ' workspace',
        organization,
        apiKey: this.authHelper.generateApiKey(),
        timezoneUTCOffset: body.timezoneUTCOffset,
      });
      await queryRunner.manager.save(workspace);

      const team = await queryRunner.manager.create(OrganizationTeam, {
        teamName: 'Default team',
        organization,
        members: [
          {
            id: account.id,
          },
        ],
      });
      await queryRunner.manager.save(team);

      await this.authHelper.generateDefaultData(account, queryRunner, session);

      await queryRunner.commitTransaction();
    } catch (err) {
      await queryRunner.rollbackTransaction();
      this.error(err, this.update, session, account.id);
      throw new BadRequestException('Error during creation');
    } finally {
      await queryRunner.release();
    }
  }

  // Will need update on for multiple workspaces and organization management
  public async getTeamMembers(
    account: Account,
    take = 10,
    skip = 0,
    isASC = false
  ) {
    if (!account.teams?.[0]) {
      throw new BadRequestException(
        'You have no team, finish company setup first'
      );
    }

    const sortOrder = isASC ? 'ASC' : 'DESC';

    const [members, total] = await this.accountRepository
      .createQueryBuilder('account')
      .innerJoin('account.teams', 'team', 'team.id = :teamId', {
        teamId: account.teams[0].id,
      })
      .orderBy('account.accountCreatedAt', sortOrder)
      .skip(skip)
      .take(take)
      .getManyAndCount();

    return {
      data: members.map((el) => ({
        id: el.id,
        name: el.firstName,
        lastName: el.lastName,
        email: el.email,
        createdAt: el.accountCreatedAt,
      })),
      total,
      page: skip / take + 1,
      pageCount: Math.ceil(total / take),
    };
  }

  public async inviteMember(
    account: Account,
    body: InviteMemberDTO,
    session: string
  ) {
    const team = account.teams?.[0];

    const organization = team.organization;
    const plan = organization.plan;

    const teamMembersCount = await this.accountRepository.countBy({
      teams: { id: team.id },
    });

    if (plan.seatLimit != -1) {
      if (teamMembersCount + 1 > plan.seatLimit) {
        throw new HttpException(
          'Seat limit has been exceeded',
          HttpStatus.PAYMENT_REQUIRED
        );
      }
    }

    const invite = await this.organizationInvitesRepository.findOne({
      where: {
        organization: {
          id: team.organization.id,
        },
        email: body.email,
      },
    });
    const existingAccount = await this.accountRepository.findOneBy({
      email: body.email,
    });
    if (existingAccount) {
      throw new HttpException(
        'This user already have registered account.',
        HttpStatus.BAD_REQUEST
      );
    }
    if (invite) {
      throw new HttpException(
        'This user already invited.',
        HttpStatus.BAD_REQUEST
      );
    }

    const queryRunner = await this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();
      await queryRunner.startTransaction();

      const createdInvite = await queryRunner.manager.save(
        OrganizationInvites,
        {
          email: body.email,
          organization: team.organization,
          team: team,
        }
      );
      const inviteLink = `${process.env.FRONTEND_URL}/confirm-invite/${createdInvite.id}`;

      if (process.env.EMAIL_VERIFICATION_PROVIDER === 'gmail') {
        await Producer.add(QueueType.MESSAGE, {
          eventProvider: 'gmail',
          key: process.env.GMAIL_APP_CRED,
          from: 'Laudspeaker',
          email: process.env.GMAIL_VERIFICATION_EMAIL,
          to: body.email,
          subject: `You have been invited to organization: ${team.organization.companyName}`,
          plainText: 'Paste the following link into your browser:' + inviteLink,
          text: `Paste the following link into your browser: <a href="${inviteLink}">${inviteLink}</a>`,
        }, 'email');
      } else if (process.env.EMAIL_VERIFICATION_PROVIDER === 'mailgun') {
        await Producer.add(QueueType.MESSAGE, {
          key: process.env.MAILGUN_API_KEY,
          from: 'Laudspeaker',
          domain: process.env.MAILGUN_DOMAIN,
          email: 'noreply',
          to: body.email,
          subject: `You have been invited to organization: ${team.organization.companyName}`,

          text: `Link: <a href="${inviteLink}">${inviteLink}</a>`,
        }, 'email');
      } else {
        //default is mailgun right now
        await Producer.add(QueueType.MESSAGE, {
          key: process.env.MAILGUN_API_KEY,
          from: 'Laudspeaker',
          domain: process.env.MAILGUN_DOMAIN,
          email: 'noreply',
          to: body.email,
          subject: `You have been invited to organization: ${team.organization.companyName}`,
          text: `Link: <a href="${inviteLink}">${inviteLink}</a>`,
        }, 'email');
      }
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();

      this.error(error, this.create, session, account.id);

      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  public async disconnectFirebase(
    account: Account,
    body: DisconnectFirebaseDTO,
    session: string
  ) {
    const workspace = account?.teams?.[0]?.organization?.workspaces?.[0];

    if (!workspace) {
      throw new BadRequestException(
        "You don't have access to discconnect credentials."
      );
    }
    try {
      workspace.pushPlatforms[body.platform] = undefined;
      await workspace.save();
      return;
    } catch (error) {
      this.error(error, this.disconnectFirebase.name, session, account.email);
      throw error;
    }
  }

  public async transferOwnerRights(
    account: Account,
    teamMemberAccountId: string,
    session: string
  ) {
    const organizationOwner = account?.teams?.[0]?.organization?.owner;
    const organization = account?.teams?.[0]?.organization;
    if (organizationOwner.id !== account.id)
      throw new HttpException(
        "You don't have rights to move ownership",
        HttpStatus.NOT_ACCEPTABLE
      );

    const teamId = account?.teams?.[0].id;

    const teamWithAccount = await this.organizationTeamRepository
      .createQueryBuilder('team')
      .innerJoinAndSelect('team.members', 'member')
      .where('team.id = :teamId', { teamId })
      .andWhere('member.id = :teamMemberAccountId', { teamMemberAccountId })
      .getOne();

    const newOwner = teamWithAccount?.members?.[0];
    if (!teamWithAccount || !newOwner)
      throw new HttpException(
        'This user not part of organization',
        HttpStatus.NOT_ACCEPTABLE
      );

    organization.owner = newOwner;
    await organization.save();
  }

  public async deleteMemberAccount(
    account: Account,
    teamMemberAccountId: string,
    session: string
  ) {
    const organizationOwner = account?.teams?.[0]?.organization?.owner;

    if (teamMemberAccountId === organizationOwner.id)
      throw new HttpException(
        "Owner can't be deleted",
        HttpStatus.NOT_ACCEPTABLE
      );

    if (
      teamMemberAccountId !== account.id &&
      account.id !== organizationOwner.id
    )
      throw new HttpException(
        "You don't have rights to delete user",
        HttpStatus.NOT_ACCEPTABLE
      );

    const teamId = account?.teams?.[0].id;

    const teamWithAccount = await this.organizationTeamRepository
      .createQueryBuilder('team')
      .innerJoinAndSelect('team.members', 'member')
      .where('team.id = :teamId', { teamId })
      .andWhere('member.id = :teamMemberAccountId', { teamMemberAccountId })
      .getOne();

    const foundAccount = teamWithAccount?.members?.[0];

    if (!teamWithAccount || !foundAccount)
      throw new HttpException(
        'This user not part of organization',
        HttpStatus.NOT_ACCEPTABLE
      );

    await foundAccount.remove();
  }

  public async checkInviteStatus(id: string, sessions: string) {
    const invite = await this.organizationInvitesRepository.findOne({
      where: { id },
      relations: {
        organization: {
          owner: true,
        },
      },
    });
    if (!invite) {
      throw new HttpException('No such invite found.', HttpStatus.BAD_REQUEST);
    }

    return invite;
  }

  public async checkOrganizationMessageLimit(
    workspaceIds: string[],
    messagesToSend = 1,
    customerMessageLimit: number
  ) {
    if (workspaceIds.length === 0) {
      return;
    }

    const res = await this.clickhouseClient.query({
      query: `SELECT COUNT(*) FROM ${ClickHouseTable.MESSAGE_STATUS} WHERE workspaceId IN {workspaceIds:String}`,
      query_params: {
        workspaceIds: `(${workspaceIds.join(',')})`,
      },
    });

    const messagesCountResponseData = (
      await res.json<{ data: { 'count()': string }[] }>()
    )?.data;

    const messagesCount = +messagesCountResponseData?.[0]?.['count()'] || 0;

    if (messagesCount + messagesToSend > customerMessageLimit) {
      throw new HttpException(
        'Message limit has been exceeded',
        HttpStatus.PAYMENT_REQUIRED
      );
    }

    return messagesCount;
  }
}
