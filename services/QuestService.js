const { Service: _ContentService } = require("./ContentService");
const { Service: QuestRewardService } = require("./QuestRewardService");
const { Service: _IndexerRuleService } = require("./IndexerRuleService");
const { Service: _AlchemyService } = require("./AlchemyService");

const { Quest } = require("../models/quests/Quest");
const { CommunityQuest } = require("../models/quests/CommunityQuest");
const { AccountAddress } = require("../models/AccountAddress");
const { IndexerRule } = require("../models/IndexerRule");
const { prod } = require("../helpers/registrar");

class QuestService extends QuestRewardService {
  requiredDataByRequirementType(type) {
    switch (type) {
      case "COMMUNITY_PARTICIPATION":
        // @params indexer rule id determines the rule to check when an account checks in
        // @params requiredParticipationCount determines the number of accounts check in needed to complete the quest
        return ["richBlockId", "requiredParticipationCount"];
      case "MULTICHOICE_SINGLE_QUIZ":
        return ["question", "answers", "correctAnswer"];
      default:
        return [];
    }
  }

  async getQuestReward(questReward) {
    return this.getQuestRewardItem(questReward);
  }

  checkRequirementDataOrError({ type, data }) {
    const requiredData = this.requiredDataByRequirementType(type);
    if (!requiredData?.length) return true;
    const missingData = requiredData.filter(
      (key) => !data?.find?.((data) => data?.key === key)
    );
    if (missingData?.length) {
      throw new Error(
        `Missing data for ${type} requirement: ${missingData.join(", ")}`
      );
    }
    return true;
  }

  /**
   * Check if a COMMUNITY_PARTICIPATION quest can be completed by an account
   * Under the hood this uses the same logic as claim role
   * @returns Promise<Boolean>
   * */
  async _canCompleteCommunityParticipationQuest(
    quest,
    { requirement, communityId },
    context
  ) {
    const richBlockId = requirement?.data?.find?.(
      (data) => data?.key === "richBlockId"
    )?.value;
    if (!richBlockId) return false;
    const IndexerRuleService = new _IndexerRuleService();
    try {
      const indexerRule = await IndexerRule.findOne({
        ruleOwnerType: 2,
        ruleOwnerId: richBlockId,
      });
      if (!indexerRule) return false;
      const address = await AccountAddress.findOne({
        account: context.account._id || context.accountId,
      });
      if (!address) return false;

      return IndexerRuleService.canClaimRole(indexerRule, {
        data: { communityId: communityId, address: address.address },
      });
    } catch (e) {
      return false;
    }
  }

  /**
   * Check if a VALID_NFT quest can be completed by an account
   * Under the hood this uses the same logic as claim role
   * @returns Promise<Boolean>
   * */
  async _canCompleteValidNFTQuest(quest, { requirement }, context) {
    const dataMapping = {};
    requirement?.data?.forEach((dataItem) => {
      if (dataItem?.key) {
        dataMapping[dataItem.key] = dataItem.value;
      }
    });

    const {
      contractAddress,
      count = 1,
      attributeType = null,
      attributeValue = null,
    } = dataMapping;
    if (!contractAddress) return false;

    const AlchemyService = new _AlchemyService({
      apiKey: prod().NODE_URL,
      chain: prod().NODE_NETWORK,
    });

    try {
      await context.account?.populate?.("addresses");
      const isOwner = await AlchemyService.verifyOwnership({
        address: context.account.addresses?.[0]?.address,
        contractAddresses: [contractAddress],
        count,
        attributeType,
        attributeValue,
      });
      return isOwner;
    } catch (e) {
      return false;
    }
  }
  /**
   * Check if the quest can be completed by an account
   * @TODO add more than one requirement
   * @TODO THIS IS GOING TO BE DEPRECATED FOR PRE-REQUESITES, DO NOT USE ANYMORE
   * @returns Promise<Boolean>
   * */
  // * @TODO THIS IS GOING TO BE DEPRECATED FOR PRE-REQUESITES, DO NOT USE ANYMORE
  async canCompleteQuest(quest, { communityId }, context) {
    if (!quest || !context.account) return false;
    const requirement = quest.requirements?.[0];
    if (!requirement) return true;
    if (
      requirement.type.includes("FARCASTER") ||
      requirement.type.includes("VALID_NFT")
    )
      return true;
    switch (requirement.type) {
      case "COMMUNITY_PARTICIPATION":
        return await this._canCompleteCommunityParticipationQuest(
          quest,
          { requirement, communityId },
          context
        );
      default:
        return false;
    }
  }
  // * @TODO THIS IS GOING TO BE DEPRECATED FOR PRE-REQUESITES, DO NOT USE ANYMORE

  /**
   * Create Quest Rewards or use existing Assets
   * @returns Promise<QuestRewards>
   * */
  async createQuestRewards({ rewards = [] } = {}) {
    if (!rewards?.length) return [];
    const questRewards = await Promise.all(
      rewards.map(async (reward) => {
        if (reward.rewardId) {
          return {
            type: reward.type,
            rewardId: reward.rewardId,
            quantity: reward.quantity,
            title: reward.title,
            isSponsored: reward.isSponsored,
          };
        } else {
          const rewardItem = await this.createQuestRewardItem({
            type: reward.type,
            data: reward.data,
          });
          return {
            type: reward.type,
            rewardId: rewardItem?._id,
            quantity: reward.quantity,
            title: reward.title,
            isSponsored: reward.isSponsored,
          };
        }
      })
    );
    return questRewards;
  }

  /**
   * Create Quest Requirements
   * @returns Promise<QuestRequirements>
   * */
  async createQuestRequirements({ requirements = [] } = {}) {
    if (!requirements?.length) return [];
    const questRequirements = await Promise.all(
      requirements.map(async (requirement) => {
        this.checkRequirementDataOrError({
          type: requirement.type,
          data: requirement.data,
        });
        return {
          type: requirement.type,
          data: requirement.data,
          title: requirement.title,
        };
      })
    );
    return questRequirements;
  }

  /**
   * Create a Quest with Requirements and Rewards
   * @returns Promise<Quest>
   * */
  async createWithRequirementsAndRewards({
    title,
    description = {
      raw: "",
      html: "",
      json: "",
    },
    schedule,
    imageUrl,
    requirements = [],
    rewards = [],
    community,
    startsAt,
    endsAt,
  } = {}) {
    const ContentService = new _ContentService();
    const content = ContentService.makeContent({
      contentRaw: description.raw,
      contentHtml: description.html,
      contentJson: description.json,
    });
    const quest = new Quest({
      title,
      description: content,
      imageUrl,
      schedule,
      community,
      startsAt,
      endsAt,
    });
    quest.requirements = await this.createQuestRequirements({
      requirements,
    });
    quest.rewards = await this.createQuestRewards({ rewards });
    await quest.save();
    await CommunityQuest.findOrCreate({
      communityId: community,
      questId: quest._id,
    });
    return quest;
  }
}

module.exports = { Service: QuestService };
